import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client';
import { generateInsights } from '../insights/engine';
import { detectRecurringCharges } from '../insights/recurring';
import { isActive, missedCharge } from '../health/detectedSubscriptions';
import { periodKey } from '../insights/periods';
import { recentMonths } from '../insights/recentMonths';
import { accountCoverageFrom } from '../ui/coverage';
import { payLevels } from '../ui/payLevel';
import { isP2P, isUnreviewedP2P } from '../p2p';
import { assessNetWorthGoal, parseNetWorthGoal } from '../ui/netWorthGoal';
import { growthBetween } from '../ui/netWorthGrowth';
import { groupByPayee } from '../sync/grouping';
import { suggestGroupCategories } from '../sync/groupSuggest';
import { suggestP2PCategories } from '../sync/p2pSuggest';
import { installRulePack, pendingPackRules } from '../sync/rulePack';
import type { AnomalyPayload, CashFlowTrendPayload, NetWorthGrowthPayload, RecurringChargePayload } from '../../types/contracts';
import { buildDemoData, DEMO_HISTORY_MONTHS, writeDemoData, type DemoPlan } from './data';
import { scanText } from '../../../scripts/privacyScan';

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

  it('covers eleven years of history plus the month being lived in', () => {
    const months = new Set(plan.txns.map((t) => periodKey(t.date, 'MONTH')));
    expect(months.size).toBe(DEMO_HISTORY_MONTHS + 1);
    expect(months.has(periodKey(newestSync, 'MONTH'))).toBe(true);
  });

  it('gives every account a snapshot inside every month, so no history is "estimated"', () => {
    const months = [...new Set(plan.txns.map((t) => periodKey(t.date, 'MONTH')))];
    // The rollover's statements start two years back ON PURPOSE: before them
    // it is left out, which is what Trends' "accounts joining" shows.
    for (const a of plan.accounts.filter((x) => x.key !== 'rollover')) {
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

  it('flags the cancelled gym MISSED, never lapsed, whatever the day', () => {
    const detected = detectRecurringCharges(
      plan.txns.map((t) => ({
        id: t.id,
        accountId: t.accountKey,
        date: t.date,
        amount: t.amount,
        description: t.description,
        normalizedMerchant: t.merchant,
        flow: t.flow,
        categoryId: t.category,
        categoryName: t.category,
        categoryIsIncome: t.category === 'Income',
        reimbursesId: t.reimburses ?? null,
      })),
    );
    const gym = detected.get('ironleaf fitness');
    expect(gym?.cadence).toBe('MONTHLY');
    expect(isActive(gym!, now)).toBe(true);
    expect(missedCharge(gym!, now)).not.toBeNull();
    // The rest of the subscriptions are still billing.
    for (const merchant of ['streamflix', 'tunebox premium']) expect(missedCharge(detected.get(merchant)!, now), merchant).toBeNull();
    // The music plan's renamed descriptor is followed: one plan, both names.
    expect(detected.get('tunebox premium')?.aliases).toEqual(['tunebox']);
    expect(detected.has('tunebox')).toBe(false);
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

  it('declares one savings goal, the house, and the net worth goal', () => {
    const savings = plan.settings.find((s) => s.key === 'goals.savings')?.value as { id: string }[];
    expect(savings.map((g) => g.id)).toEqual(['house-deposit']);
    expect(plan.settings.some((s) => s.key === 'goals.netWorth')).toBe(true);
  });

  // The links are written a few hundred rows per statement, not one per row.
  it('writes every transfer pair and the repayment link', async () => {
    const [paired, transfers, repaid] = await Promise.all([
      prisma.transaction.count({ where: { transferPairId: { not: null } } }),
      prisma.transaction.count({ where: { flow: 'TRANSFER' } }),
      prisma.transaction.count({ where: { reimbursesId: { not: null } } }),
    ]);
    expect(paired).toBe(transfers);
    expect(paired).toBeGreaterThan(1000);
    expect(repaid).toBe(1);
  });

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

  it('gives grouped review a suggestion to show: the pottery studio, by its other spelling', async () => {
    const [waiting, history, categories] = await Promise.all([
      prisma.transaction.findMany({ where: { categoryId: null, flow: { not: 'TRANSFER' }, reimbursesId: null } }),
      prisma.transaction.findMany({ where: { categoryId: { not: null }, flow: { not: 'TRANSFER' } } }),
      prisma.category.findMany(),
    ]);
    const rows = waiting.map((t) => ({ ...t, amount: Number(t.amount) }));
    const byId = new Map(rows.map((t) => [t.id, t]));
    const groups = groupByPayee(rows).map((g) => ({ key: g.key, isP2P: g.isP2P, rows: g.transactionIds.map((id) => byId.get(id)!) }));
    const suggested = suggestGroupCategories(
      groups,
      history.map((h) => ({ ...h, amount: Number(h.amount), categoryId: h.categoryId!, isP2P: isP2P(h) })),
      [],
      new Map(categories.map((c) => [c.name, c.id])),
    );
    const pottery = suggested.get('lantern pottery studio');
    expect(pottery?.strength).toBe('strong');
    expect(pottery?.reason).toEqual({ kind: 'TWIN', like: 'lantern pottery studio #2' });
    expect(categories.find((c) => c.id === pottery?.categoryId)?.name).toBe('Shopping');
  });

  it('leaves the rollover out before its first statement, and names it joining rather than saved', async () => {
    const rows = await prisma.insight.findMany({ where: { type: 'NET_WORTH_GROWTH' }, orderBy: { period: 'asc' } });
    const rollover = (await prisma.account.findFirst({ where: { name: { startsWith: 'Rollover' } } }))!;
    const points = rows.map((r) => {
      const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as NetWorthGrowthPayload;
      return { period: r.period, value: p.netWorth, estimated: false, leftOut: p.excludedAccountIds ?? [], marketGains: p.marketGains };
    });
    const joins = points.findIndex((p) => !p.leftOut.includes(rollover.id));
    expect(points[joins].period).toBe('2024-09');
    expect(points[joins - 1].leftOut).toEqual([rollover.id]);
    const g = growthBetween(points, joins - 1, joins + 2);
    expect(g.joined).toBeGreaterThan(15_000);
    expect(g.saved + g.markets + g.joined).toBeCloseTo(g.change, 2);
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

  it('shows a net worth goal with both dates, the return applied to invested money', async () => {
    const [rows, accounts, setting] = await Promise.all([
      prisma.insight.findMany({ where: { type: 'NET_WORTH_GROWTH', period: { lt: '2026-09' } }, orderBy: { period: 'asc' } }),
      prisma.account.findMany(),
      prisma.setting.findUnique({ where: { key: 'goals.netWorth' } }),
    ]);
    const goal = parseNetWorthGoal(setting?.value ?? null);
    expect(goal).not.toBeNull();
    const g = assessNetWorthGoal({
      goal: goal!,
      liveNetWorth: accounts.reduce((s, a) => s + Number(a.balance), 0),
      months: rows.map((r) => {
        const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as NetWorthGrowthPayload;
        return {
          period: r.period,
          value: p.netWorth,
          estimated: p.estimatedAccountIds.length > 0,
          leftOut: p.excludedAccountIds ?? [],
          marketGains: p.marketGains,
          byAccount: p.byAccount ?? null,
          flowsByAccount: p.investmentFlowsByAccount ?? null,
        };
      }),
      investedIds: new Set(accounts.filter((a) => a.type === 'INVESTMENT').map((a) => a.id)),
    });
    expect(g.refusal).toBeNull();
    expect(g.saving?.lands).not.toBeNull();
    expect(g.markets?.lands).not.toBeNull();
    expect(g.markets!.lands! < g.saving!.lands!).toBe(true);
    // The chart exists to show the two apart: markets land years sooner.
    const index = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
    expect(index(g.saving!.lands!) - index(g.markets!.lands!)).toBeGreaterThanOrEqual(60);
    // This year's brokerage (925) and IRA (310) deposits are the monthly
    // deposit; March's bonus moved into the brokerage is a lump sum it ignores.
    expect(g.contribution).toBe(1235);
    expect(g.unmatchedDeposit).toBeNull();
  });

  // The fuel card opened four months before NOW (2026-05): March and April
  // predate its records, so the paces, readiness and the runway name them.
  it('names the months before its newest card in the window the projections average', async () => {
    const [accounts, firsts] = await Promise.all([
      prisma.account.findMany({ select: { id: true, name: true, type: true } }),
      prisma.transaction.groupBy({ by: ['accountId'], _min: { date: true } }),
    ]);
    const complete = Array.from({ length: 12 }, (_, i) => periodKey(new Date(Date.UTC(2025, 8 + i, 1)), 'MONTH'));
    const w = recentMonths(complete, accountCoverageFrom(accounts, firsts).map((a) => a.firstTransaction));
    expect(w.used).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    expect(w.dropped).toEqual([]);
    expect(w.short).toEqual(['2026-03', '2026-04']);
  });

  it('reads its new job three months back as a job change, the old months at the new pay', async () => {
    const flows = await payloads<CashFlowTrendPayload>('CASH_FLOW_TREND');
    const pay = payLevels(flows.flatMap((f) => f.paychecks ?? []), []);
    expect(pay.changes.find((c) => c.replaces !== undefined)).toMatchObject({ payer: 'lakeshore analytics', replaces: 'northwind labs', since: '2026-06-01' });
    expect(pay.topUps['2026-05']).toBeGreaterThan(0);
    expect(pay.pending).toEqual([]);
  });

  it('leaves its April tax refund and its March bonus out of the paces as one-off income', async () => {
    const [april] = await payloads<CashFlowTrendPayload>('CASH_FLOW_TREND', '2026-04');
    expect(april.oneOffPay?.map((o) => o.payer)).toEqual(['us treasury tax refund']);
    const [march] = await payloads<CashFlowTrendPayload>('CASH_FLOW_TREND', '2026-03');
    expect(march.oneOffPay?.map((o) => o.payer)).toEqual(['northwind labs']);
  });

  it('shows a price rise, a one-off this month, and no groceries or fuel mistaken for subscriptions', async () => {
    const recurring = await payloads<RecurringChargePayload>('RECURRING_CHARGE');
    expect(recurring.find((r) => r.merchant === 'streamflix')?.priceIncreased).toBe(true);
    // Electricity peaks summer and winter: a bill that moves is not a rise.
    expect(recurring.find((r) => r.merchant === 'citylight electric')?.priceIncreased).toBe(false);
    expect(recurring.map((r) => r.merchant)).not.toEqual(expect.arrayContaining(['summit fuel']));
    expect(recurring.map((r) => r.merchant)).not.toEqual(expect.arrayContaining(['corner grocer']));
    const anomalies = await payloads<AnomalyPayload>('ANOMALY', '2026-09');
    expect(anomalies.some((a) => a.description === 'brightline electronics')).toBe(true);
  });
});
