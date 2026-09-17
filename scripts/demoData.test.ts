import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client';
import { generateInsights } from '../src/lib/insights/engine';
import { periodKey } from '../src/lib/insights/periods';
import { isUnreviewedP2P } from '../src/lib/p2p';
import { suggestP2PCategories } from '../src/lib/sync/p2pSuggest';
import { installRulePack, pendingPackRules } from '../src/lib/sync/rulePack';
import type { AnomalyPayload, NetWorthGrowthPayload, RecurringChargePayload } from '../src/types/contracts';
import { buildDemoData, DEMO_HISTORY_MONTHS, writeDemoData, type DemoPlan } from './demoData';
import { scanText } from './privacyScan';

/**
 * The demo exists to put something on every screen whatever day it is
 * generated, so its promises are checked across the days that break naive
 * date code: mid-month, the first of a month before and after its sync, a
 * year boundary, and the day after a leap day.
 */
const NOWS = [
  '2026-09-16T20:00:00Z', // mid-month, before that day's sync
  '2026-10-01T00:30:00Z', // first of the month, before its sync: data ends Sep 30
  '2026-10-01T23:30:00Z', // first of the month, after its sync
  '2027-01-01T05:00:00Z', // year boundary
  '2028-03-01T23:59:00Z', // the day after Feb 29
];

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

describe.each(NOWS)('buildDemoData at %s', (iso) => {
  const now = new Date(iso);
  const plan = buildDemoData(now);
  const newestSync = plan.syncTimes[plan.syncTimes.length - 1];
  const accountKey = (key: string) => plan.accounts.find((a) => a.key === key)!;

  it('is deterministic for a given moment', () => {
    expect(JSON.stringify(buildDemoData(now))).toBe(JSON.stringify(plan));
  });

  it('never dates a row, a snapshot or a sync after the newest sync could have seen it', () => {
    expect(newestSync.getTime()).toBeLessThanOrEqual(now.getTime());
    for (const t of plan.txns) expect(dayOf(t.date) <= dayOf(newestSync), t.description).toBe(true);
    for (const s of plan.snapshots) expect(s.date.getTime()).toBeLessThanOrEqual(newestSync.getTime() + 12 * 3_600_000);
  });

  it('covers 24 months of history plus the month being lived in', () => {
    const months = new Set(plan.txns.map((t) => periodKey(t.date, 'MONTH')));
    expect(months.size).toBe(DEMO_HISTORY_MONTHS + 1);
    expect(months.has(periodKey(newestSync, 'MONTH'))).toBe(true);
  });

  it('gives every account a snapshot inside every month, so no history is "estimated"', () => {
    const months = [...new Set(plan.txns.map((t) => periodKey(t.date, 'MONTH')))];
    for (const a of plan.accounts) {
      const covered = new Set(plan.snapshots.filter((s) => s.accountKey === a.key).map((s) => periodKey(s.date, 'MONTH')));
      for (const m of months) expect(covered.has(m), `${a.key} ${m}`).toBe(true);
    }
  });

  it('pairs every transfer with its opposite in another account', () => {
    const byId = new Map(plan.txns.map((t) => [t.id, t]));
    const transfers = plan.txns.filter((t) => t.flow === 'TRANSFER');
    expect(transfers.length).toBeGreaterThan(0);
    for (const t of transfers) {
      const other = byId.get(t.pairWith!)!;
      expect(other.pairWith).toBe(t.id);
      expect(other.amount).toBe(-t.amount);
      expect(other.accountKey).not.toBe(t.accountKey);
    }
  });

  it('links its reimbursement to an outflow', () => {
    const repay = plan.txns.filter((t) => t.reimburses !== undefined);
    expect(repay).toHaveLength(1);
    expect(plan.txns.find((t) => t.id === repay[0].reimburses)?.flow).toBe('OUTFLOW');
  });

  it('keeps checking above zero every day', () => {
    // The plan's balance is the END; walk back from it.
    let balance = accountKey('checking').balance;
    const rows = plan.txns.filter((t) => t.accountKey === 'checking').sort((a, b) => b.date.getTime() - a.date.getTime());
    for (const t of rows) {
      expect(balance).toBeGreaterThanOrEqual(0);
      balance -= t.amount;
    }
    expect(balance).toBeGreaterThan(0);
  });

  it('awaits confirmation on three P2P payments — one per kind of suggestion, and one with none', () => {
    const awaiting = plan.txns.filter((t) =>
      isUnreviewedP2P({ ...t, normalizedMerchant: t.merchant, categoryId: t.category, reimbursesId: t.reimburses ?? null }),
    );
    expect(awaiting).toHaveLength(3);
    const history = plan.txns
      .filter((t) => t.category !== null && /zelle|venmo/i.test(t.description))
      .map((t) => ({ amount: t.amount, date: t.date, description: t.description, categoryId: t.category! }));
    const rules = plan.rules.map((r, i) => ({
      id: `r${i}`, priority: 50, matchField: r.matchField, matchOperator: 'CONTAINS' as const, matchValue: r.matchValue,
      setCategoryId: r.category, setFlow: null, enabled: true,
    }));
    const found = suggestP2PCategories(
      awaiting.map((t) => ({ id: t.id, amount: t.amount, date: t.date, description: t.description, normalizedMerchant: t.merchant, accountName: t.accountKey, categorySource: t.categorySource })),
      history,
      rules,
    );
    expect([...found.values()].map((s) => s.reason.kind).sort()).toEqual(['RULE', 'SAME_AMOUNT']);
    expect(found.size).toBe(2);
  });

  it('carries only invented account identifiers', () => {
    for (const a of plan.accounts) expect(a.name).toMatch(/\.\.\.000\d$/);
  });

  it('passes the privacy scan on every string it would put on a public page', () => {
    // privacy.test.ts scans TRACKED files, so a generator that is not yet
    // committed escapes it on a local run — and a screenshot or the demo
    // shows these strings, not the source. Scan what is generated.
    const strings = [
      ...plan.accounts.flatMap((a) => [a.name, a.institution]),
      ...plan.txns.flatMap((t) => [t.description, t.merchant, t.groupLabel ?? '']),
    ];
    expect(scanText('demo data', strings.join('\n'))).toEqual([]);
  });
});

describe('the demo through the real pipeline', () => {
  let dir: string;
  let prisma: PrismaClient;
  let plan: DemoPlan;
  const NOW = new Date('2026-09-16T20:00:00Z');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ducat-demo-test-'));
    const url = `file:${join(dir, 'demo.db').replace(/\\/g, '/')}`;
    const conn = await new PrismaBetterSqlite3({ url }).connect();
    const migrations = join(process.cwd(), 'prisma', 'migrations');
    for (const name of readdirSync(migrations, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      await conn.executeScript(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
    }
    await conn.dispose();
    prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
    plan = buildDemoData(NOW);
    await writeDemoData(prisma, plan);
    await installRulePack(prisma);
    await generateInsights(prisma);
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const payloads = async <T>(type: string, period?: string) =>
    (await prisma.insight.findMany({ where: { type: type as never, ...(period ? { period } : {}) } })).map(
      (r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as T,
    );

  it('leaves no rule-pack drift, so Overview does not ask for an upgrade', async () => {
    expect(await pendingPackRules(prisma)).toBe(0);
  });

  it('keeps its review items for review — the pack categorizes none of them', async () => {
    const waiting = await prisma.transaction.findMany({
      where: { categoryId: null, flow: { not: 'TRANSFER' }, reimbursesId: null },
      select: { description: true },
    });
    expect(waiting.map((t) => t.description.split(' ON ')[0]).sort()).toEqual(
      ['SQ *LANTERN POTTERY STUDIO', 'VENMO PAYMENT 1000000007 CASEY MORGAN', 'ZELLE TO ALEX RIVERA', 'ZELLE TO SAM LEE'].sort(),
    );
  });

  it('knows net worth for every complete month — no account reconstructed', async () => {
    const rows = await prisma.insight.findMany({ where: { type: 'NET_WORTH_GROWTH' }, orderBy: { period: 'asc' } });
    expect(rows.length).toBe(DEMO_HISTORY_MONTHS + 1);
    // The month being lived in is excluded on purpose: its end is still ahead,
    // so today's investment values honestly stand in as ESTIMATED for it, as
    // they would on a real instance.
    for (const r of rows.filter((row) => row.period < '2026-09')) {
      const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as NetWorthGrowthPayload;
      expect(p.estimatedAccountIds, r.period).toEqual([]);
    }
  });

  it('shows a price rise, a one-off this month, and no groceries or fuel mistaken for subscriptions', async () => {
    const recurring = await payloads<RecurringChargePayload>('RECURRING_CHARGE');
    expect(recurring.find((r) => r.merchant === 'streamflix')?.priceIncreased).toBe(true);
    expect(recurring.map((r) => r.merchant)).not.toEqual(expect.arrayContaining(['summit fuel']));
    expect(recurring.map((r) => r.merchant)).not.toEqual(expect.arrayContaining(['corner grocer']));
    const anomalies = await payloads<AnomalyPayload>('ANOMALY', '2026-09');
    expect(anomalies.some((a) => a.description === 'brightline electronics')).toBe(true);
  });
});
