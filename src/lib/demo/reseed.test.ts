import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client';
import { reseedDemo } from './reseed';

/**
 * The public demo's nightly job. Visitors change things all day — categories,
 * rules, trips, subscriptions — and the reset must put every one of them back,
 * leave the data dated to the NEW day, and never touch auth state.
 */
describe('reseedDemo', () => {
  let dir: string;
  let prisma: PrismaClient;
  const DAY_ONE = new Date('2026-09-16T23:30:00Z');
  const DAY_TWO = new Date('2026-09-17T23:30:00Z');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ducat-reseed-test-'));
    const url = `file:${join(dir, 'demo.db').replace(/\\/g, '/')}`;
    const conn = await new PrismaBetterSqlite3({ url }).connect();
    const migrations = join(process.cwd(), 'prisma', 'migrations');
    for (const name of readdirSync(migrations, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      await conn.executeScript(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
    }
    await conn.dispose();
    prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const snapshot = async () => ({
    accounts: await prisma.account.count(),
    transactions: await prisma.transaction.count(),
    rules: await prisma.rule.count(),
    categories: await prisma.category.count(),
    tracked: await prisma.trackedSubscription.count(),
    tagged: await prisma.transaction.count({ where: { groupLabel: { not: null } } }),
    manual: await prisma.transaction.count({ where: { categorySource: 'MANUAL' } }),
  });

  it('undoes whatever visitors changed, moves the data to the new day, and keeps auth state', async () => {
    await reseedDemo(prisma, DAY_ONE);
    const fresh = await snapshot();
    expect(fresh.transactions).toBeGreaterThan(800);

    // A day of visitors: a rule, a tag, a recategorised row, a registered
    // subscription, a backup record, and a TOTP counter the login wrote.
    const someRow = await prisma.transaction.findFirstOrThrow({ where: { flow: 'OUTFLOW' } });
    const dining = await prisma.category.findFirstOrThrow({ where: { name: 'Dining' } });
    await prisma.rule.create({
      data: { priority: 40, matchField: 'MERCHANT', matchOperator: 'CONTAINS', matchValue: 'visitor rule', setCategoryId: dining.id, enabled: true },
    });
    await prisma.transaction.update({ where: { id: someRow.id }, data: { groupLabel: 'Visitor trip', categoryId: dining.id } });
    await prisma.trackedSubscription.create({
      data: { name: 'Visitor sub', merchantPattern: 'visitor', expectedAmount: 9, cadence: 'MONTHLY', anchorDate: DAY_ONE },
    });
    await prisma.setting.create({ data: { key: 'backup.lastRun', value: '{}' } });
    await prisma.setting.create({ data: { key: 'auth.totpLastCounter', value: '123' } });

    const second = await reseedDemo(prisma, DAY_TWO);

    // Everything visitors add is gone; the day's own data has one more day in
    // it, so transactions (and the MANUAL rows among them) are day two's plan.
    const after = await snapshot();
    expect({ ...after, transactions: 0, manual: 0 }).toEqual({ ...fresh, transactions: 0, manual: 0 });
    expect(after.transactions).toBe(second.transactions);
    expect(after.transactions).toBeGreaterThanOrEqual(fresh.transactions);
    expect(await prisma.rule.count({ where: { matchValue: 'visitor rule' } })).toBe(0);
    expect(await prisma.transaction.count({ where: { groupLabel: 'Visitor trip' } })).toBe(0);
    expect(await prisma.setting.findUnique({ where: { key: 'backup.lastRun' } })).toBeNull();
    // Auth is not data: wiping the counter would let a used TOTP code work again.
    expect((await prisma.setting.findUnique({ where: { key: 'auth.totpLastCounter' } }))?.value).toBe('123');
    // The newest sync, and so the newest data, is now day two's.
    const lastSync = await prisma.setting.findUniqueOrThrow({ where: { key: 'lastSync:SIMPLEFIN' } });
    expect(lastSync.value.slice(0, 10)).toBe('2026-09-17');
    const newest = await prisma.transaction.findFirstOrThrow({ orderBy: { date: 'desc' } });
    expect(newest.date.toISOString().slice(0, 10)).toBe('2026-09-17');
  }, 120_000);
});
