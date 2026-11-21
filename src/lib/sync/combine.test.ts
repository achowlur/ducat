import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Connector, NormalizedAccount, NormalizedTransaction } from '../../types/contracts';
import { PrismaClient } from '../../generated/prisma/client';
import { ACCOUNT_NAMES_KEY } from '../accountDisplay';
import { CASH_ACCOUNTS_KEY } from '../ui/liquidity';
import { applyCombine, findAccount, IGNORED_FEED_ACCOUNTS_KEY, planCombine, undoCombine } from './combine';
import { runSync } from './sync';

/** An account moved into a managed one under a new number, left open and empty. Invented figures. */

const DAY_MS = 86_400_000;
const day = (n: number) => new Date(Date.UTC(2026, 0, 31) - n * DAY_MS);

const dirs: string[] = [];
const clients: PrismaClient[] = [];

async function freshDatabase(): Promise<PrismaClient> {
  const dir = mkdtempSync(join(tmpdir(), 'ducat-combine-'));
  dirs.push(dir);
  const url = `file:${join(dir, 'test.db').replace(/\\/g, '/')}`;
  const factory = new PrismaBetterSqlite3({ url });
  const conn = await factory.connect();
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  for (const name of readdirSync(migrationsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    await conn.executeScript(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
  }
  await conn.dispose();
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  clients.push(prisma);
  return prisma;
}

afterAll(async () => {
  for (const client of clients) await client.$disconnect();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function seed(prisma: PrismaClient) {
  const account = (externalId: string, name: string, balance: number, created: Date) =>
    prisma.account.create({
      data: {
        externalId, connectorType: 'SIMPLEFIN', institution: 'Example Brokerage', name, type: 'INVESTMENT',
        currency: 'USD', balance, balanceDate: day(0), isStale: false, createdAt: created,
      },
    });
  const old = await account('feed-old', 'Retirement (0005)', 0, day(400));
  const managed = await account('feed-new', 'Managed - Retirement (0006)', 1250, day(0));
  const snap = (accountId: string, n: number, balance: number) => prisma.balanceSnapshot.create({ data: { accountId, date: day(n), balance } });
  await snap(old.id, 30, 1000);
  await snap(old.id, 10, 1150);
  await snap(old.id, 5, 1200);
  await snap(old.id, 3, 0);
  await snap(old.id, 0, 0);
  await snap(managed.id, 5, 40);
  await snap(managed.id, 0, 1250);
  const row = (accountId: string, externalId: string, n: number, amount: number) =>
    prisma.transaction.create({
      data: {
        accountId, externalId, date: day(n), amount, description: 'TRANSFER', normalizedMerchant: 'transfer',
        flow: 'TRANSFER', categorySource: 'AGGREGATOR', source: 'SIMPLEFIN',
      },
    });
  await row(old.id, 'o1', 20, 100);
  await row(old.id, 'o2', 4, -1200);
  await row(managed.id, 'm1', 4, 1200);
  await prisma.setting.create({ data: { key: CASH_ACCOUNTS_KEY, value: JSON.stringify([old.id]) } });
  await prisma.setting.create({ data: { key: ACCOUNT_NAMES_KEY, value: JSON.stringify({ [old.id]: 'Old pot', [managed.id]: 'Pot' }) } });
  return { old, managed };
}

describe('combining an account into the one that took over its money', () => {
  it('moves every row, sums balances by day, drops the closing zeros and keeps the old feed id out', async () => {
    const prisma = await freshDatabase();
    const { old, managed } = await seed(prisma);
    expect((await findAccount(prisma, '0005'))?.id).toBe(old.id);

    const plan = await planCombine(prisma, old.id, managed.id);
    expect(plan).toMatchObject({ rowsMoved: 2, trailingZerosDropped: 2, snapshotsSummed: 1, snapshotsMoved: 2, clashingRowIds: 0 });
    expect((await applyCombine(prisma, old.id, managed.id)).ok).toBe(true);

    expect(await prisma.account.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.transaction.count({ where: { accountId: managed.id } })).toBe(3);
    const balances = (await prisma.balanceSnapshot.findMany({ where: { accountId: managed.id }, orderBy: { date: 'asc' } })).map(
      (s) => [s.date.getTime(), Number(s.balance)],
    );
    // Old pot's real balances, the one shared day summed, the managed account's today; no zero in between.
    expect(balances).toEqual([
      [day(30).getTime(), 1000],
      [day(10).getTime(), 1150],
      [day(5).getTime(), 1240],
      [day(0).getTime(), 1250],
    ]);
    const setting = async (key: string) => JSON.parse((await prisma.setting.findUniqueOrThrow({ where: { key } })).value);
    expect(await setting(CASH_ACCOUNTS_KEY)).toEqual([managed.id]);
    expect(await setting(ACCOUNT_NAMES_KEY)).toEqual({ [managed.id]: 'Pot' });
    expect(await setting(IGNORED_FEED_ACCOUNTS_KEY)).toEqual({ SIMPLEFIN: ['feed-old'] });

    // The brokerage still lists the empty account: the sync passes it over.
    const listed = (externalId: string, name: string, balance: number): NormalizedAccount => ({
      externalId, connectorType: 'SIMPLEFIN', institution: 'Example Brokerage', name, type: 'INVESTMENT',
      currency: 'USD', balance, balanceDate: new Date(), isStale: false,
    });
    const feed: Connector = {
      type: 'SIMPLEFIN',
      listAccounts: () => Promise.resolve([listed('feed-old', 'Retirement (0005)', 0), listed('feed-new', 'Managed - Retirement (0006)', 1260)]),
      fetchTransactions: () =>
        Promise.resolve<NormalizedTransaction[]>([
          { accountExternalId: 'feed-old', externalId: 'o3', date: new Date(), amount: 1, description: 'X', normalizedMerchant: 'x', flow: 'INFLOW', source: 'SIMPLEFIN' },
        ]),
    };
    await runSync(prisma, feed, { since: day(60), skipInsights: true });
    expect(await prisma.account.count()).toBe(1);
    expect(await prisma.transaction.count()).toBe(3);
  });

  it('puts everything back exactly', async () => {
    const prisma = await freshDatabase();
    const { old, managed } = await seed(prisma);
    const state = async () => ({
      accounts: (await prisma.account.findMany({ orderBy: { id: 'asc' } })).map((a) => [a.id, a.externalId, Number(a.balance)]),
      rows: (await prisma.transaction.findMany({ orderBy: { id: 'asc' } })).map((t) => [t.id, t.accountId]),
      balances: (await prisma.balanceSnapshot.findMany({ orderBy: { id: 'asc' } })).map((s) => [s.id, s.accountId, Number(s.balance)]),
      settings: (await prisma.setting.findMany({ where: { key: { in: [CASH_ACCOUNTS_KEY, ACCOUNT_NAMES_KEY, IGNORED_FEED_ACCOUNTS_KEY] } }, orderBy: { key: 'asc' } })).map((s) => [s.key, s.value]),
    });
    const before = await state();
    expect((await applyCombine(prisma, old.id, managed.id)).ok).toBe(true);
    expect(await undoCombine(prisma, managed.id)).toEqual({ ok: true });
    expect(await state()).toEqual(before);
  });

  it('refuses copies of one account, which are a re-link and not a combine', async () => {
    const prisma = await freshDatabase();
    const { old, managed } = await seed(prisma);
    await prisma.transaction.create({
      data: {
        accountId: managed.id, externalId: 'o1', date: day(20), amount: 100, description: 'TRANSFER', normalizedMerchant: 'transfer',
        flow: 'TRANSFER', categorySource: 'AGGREGATOR', source: 'SIMPLEFIN',
      },
    });
    const result = await applyCombine(prisma, old.id, managed.id);
    expect(result.ok).toBe(false);
    expect(await prisma.account.count()).toBe(2);
  });
});
