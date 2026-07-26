import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client';
import { generateInsights } from './engine';

let dir: string;
let prisma: PrismaClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ducat-engine-test-'));
  const url = `file:${join(dir, 'test.db').replace(/\\/g, '/')}`;

  const factory = new PrismaBetterSqlite3({ url });
  const conn = await factory.connect();
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of migrations) {
    await conn.executeScript(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
  }
  await conn.dispose();

  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

  const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));
  const account = await prisma.account.create({
    data: {
      externalId: 'test-checking',
      connectorType: 'SIMPLEFIN',
      institution: 'Test Bank',
      name: 'Checking',
      type: 'DEPOSITORY',
      currency: 'USD',
      balance: 5000,
      balanceDate: utc(2026, 7, 12),
      isStale: false,
    },
  });
  const dining = await prisma.category.create({ data: { name: 'Dining' } });

  const txns = [];
  for (let m = 1; m <= 7; m++) {
    txns.push({
      accountId: account.id,
      externalId: `salary-${m}`,
      date: utc(2026, m, 1),
      amount: 3000,
      description: 'PAYROLL',
      normalizedMerchant: 'employer',
      flow: 'INFLOW' as const,
      categorySource: 'MANUAL' as const,
      source: 'SIMPLEFIN' as const,
    });
    for (let i = 0; i < 3; i++) {
      txns.push({
        accountId: account.id,
        externalId: `dining-${m}-${i}`,
        date: utc(2026, m, 5 + i * 8),
        amount: -(30 + m + i * 2),
        description: 'RESTAURANT',
        normalizedMerchant: 'local thai',
        flow: 'OUTFLOW' as const,
        categoryId: dining.id,
        categorySource: 'MANUAL' as const,
        source: 'SIMPLEFIN' as const,
      });
    }
    txns.push({
      accountId: account.id,
      externalId: `netflix-${m}`,
      date: utc(2026, m, 10),
      amount: -15.99,
      description: 'NETFLIX.COM',
      normalizedMerchant: 'netflix',
      flow: 'OUTFLOW' as const,
      categorySource: 'MANUAL' as const,
      source: 'SIMPLEFIN' as const,
    });
  }
  // Anomalous dining transaction in July (typical ~35, this is 500)
  txns.push({
    accountId: account.id,
    externalId: 'dining-anomaly',
    date: utc(2026, 7, 9),
    amount: -500,
    description: 'MICHELIN BISTRO',
    normalizedMerchant: 'michelin bistro',
    flow: 'OUTFLOW' as const,
    categoryId: dining.id,
    categorySource: 'MANUAL' as const,
    source: 'SIMPLEFIN' as const,
  });
  await prisma.transaction.createMany({ data: txns });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('generateInsights', () => {
  it('creates insights of every type across the data range', async () => {
    const result = await generateInsights(prisma);

    expect(result.periods).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
    ]);
    expect(result.byType.NET_WORTH_GROWTH).toBe(7);
    expect(result.byType.SPENDING_BY_CATEGORY).toBe(7);
    expect(result.byType.CASH_FLOW_TREND).toBe(7);
    expect(result.byType.RECURRING_CHARGE).toBeGreaterThanOrEqual(1);
    expect(result.byType.ANOMALY).toBeGreaterThanOrEqual(1);
    expect(await prisma.insight.count()).toBe(result.created);
  });

  it('is idempotent: regeneration replaces rather than duplicates', async () => {
    const first = await generateInsights(prisma);
    const second = await generateInsights(prisma);
    expect(second.created).toBe(first.created);
    expect(await prisma.insight.count()).toBe(second.created);
  });

  it('carries the dismissed flag forward across regeneration', async () => {
    await generateInsights(prisma);
    const target = await prisma.insight.findFirstOrThrow({ where: { type: 'RECURRING_CHARGE' } });
    await prisma.insight.update({ where: { id: target.id }, data: { dismissed: true } });

    await generateInsights(prisma);
    const regenerated = await prisma.insight.findFirstOrThrow({ where: { type: 'RECURRING_CHARGE' } });
    expect(regenerated.id).not.toBe(target.id); // fresh row...
    expect(regenerated.dismissed).toBe(true); // ...same dismissal

    const others = await prisma.insight.findMany({ where: { type: 'CASH_FLOW_TREND' } });
    expect(others.every((i) => !i.dismissed)).toBe(true);
  });
});
