import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Connector, NormalizedAccount, NormalizedTransaction } from '../../types/contracts';
import { PrismaClient } from '../../generated/prisma/client';
import { ACCOUNT_NAMES_KEY } from '../accountDisplay';
import { CASH_ACCOUNTS_KEY } from '../ui/liquidity';
import { applyCombine, COMBINE_UNDO_PREFIX, findAccount, IGNORED_FEED_ACCOUNTS_KEY, markCombinedMove, planCombine, undoCombine } from './combine';
import { generateInsights } from '../insights/engine';
import { INTERNAL_MOVES_KEY } from '../insights/internalMoves';
import { crossingAmount } from '../insights/netWorth';
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
      settings: (await prisma.setting.findMany({ where: { key: { in: [CASH_ACCOUNTS_KEY, ACCOUNT_NAMES_KEY, IGNORED_FEED_ACCOUNTS_KEY, INTERNAL_MOVES_KEY] } }, orderBy: { key: 'asc' } })).map((s) => [s.key, s.value]),
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

describe("the arrival of the old account's money when the feed never sent its departure", () => {
  // The old side is missing: only the kept account's arrival is on record, worded as money from outside.
  async function seedArrivalOnly(prisma: PrismaClient) {
    const seeded = await seed(prisma);
    await prisma.transaction.deleteMany({ where: { externalId: 'o2' } });
    await prisma.transaction.updateMany({ where: { externalId: 'm1' }, data: { description: 'TRANSFERRED FROM VS 000-000000-1 INDEX FUND (Cash)' } });
    return seeded;
  }
  const flowsInto = async (prisma: PrismaClient, accountId: string, period: string) => {
    const row = await prisma.insight.findFirstOrThrow({ where: { type: 'NET_WORTH_GROWTH', period } });
    return (row.payload as { investmentFlowsByAccount?: Record<string, number> }).investmentFlowsByAccount?.[accountId] ?? 0;
  };

  it('is a move inside the account once marked, crossing nothing', () => {
    const row = { amount: 1200, description: 'TRANSFERRED FROM VS 000-000000-1 (Cash)' };
    expect(crossingAmount(row)).toBe(1200);
    expect(crossingAmount({ ...row, internalMove: true })).toBe(0);
  });

  it('is found and marked by the combine, so the month counts no new money for it', async () => {
    const prisma = await freshDatabase();
    const { old, managed } = await seedArrivalOnly(prisma);
    const arrival = await prisma.transaction.findFirstOrThrow({ where: { externalId: 'm1' } });

    const plan = await planCombine(prisma, old.id, managed.id);
    expect(plan.internalMove?.rowId).toBe(arrival.id);
    expect((await applyCombine(prisma, old.id, managed.id)).ok).toBe(true);
    const marked = await prisma.setting.findUniqueOrThrow({ where: { key: INTERNAL_MOVES_KEY } });
    expect(JSON.parse(marked.value)).toEqual([arrival.id]);

    await generateInsights(prisma);
    const period = arrival.date.toISOString().slice(0, 7);
    // Only the month's real deposit (o1, +100) crosses; the arrival does not.
    expect(await flowsInto(prisma, managed.id, period)).toBe(100);

    // Undone, the mark goes with the combine.
    expect((await undoCombine(prisma, managed.id)).ok).toBe(true);
    expect(await prisma.setting.findUnique({ where: { key: INTERNAL_MOVES_KEY } })).toBeNull();
  });

  it('is found and marked afterwards for a combine applied before marks existed', async () => {
    const prisma = await freshDatabase();
    const { old, managed } = await seedArrivalOnly(prisma);
    const arrival = await prisma.transaction.findFirstOrThrow({ where: { externalId: 'm1' } });
    expect((await applyCombine(prisma, old.id, managed.id)).ok).toBe(true);
    // As an earlier combine left it: no mark, and an undo record that knows of none.
    await prisma.setting.deleteMany({ where: { key: INTERNAL_MOVES_KEY } });
    const undoRow = await prisma.setting.findUniqueOrThrow({ where: { key: COMBINE_UNDO_PREFIX + managed.id } });
    const record = JSON.parse(undoRow.value);
    delete record.internalMoveId;
    record.settingsBefore = record.settingsBefore.filter((s: { key: string }) => s.key !== INTERNAL_MOVES_KEY);
    await prisma.setting.update({ where: { key: undoRow.key }, data: { value: JSON.stringify(record) } });
    await generateInsights(prisma);
    const period = arrival.date.toISOString().slice(0, 7);
    expect(await flowsInto(prisma, managed.id, period)).toBe(1300);

    const dry = await markCombinedMove(prisma, managed.id, false);
    expect(dry).toMatchObject({ ok: true, alreadyMarked: false, move: { rowId: arrival.id } });
    expect(await prisma.setting.findUnique({ where: { key: INTERNAL_MOVES_KEY } })).toBeNull();

    expect(await markCombinedMove(prisma, managed.id, true)).toMatchObject({ ok: true, alreadyMarked: false });
    expect(await flowsInto(prisma, managed.id, period)).toBe(100);
    expect(await markCombinedMove(prisma, managed.id, true)).toMatchObject({ ok: true, alreadyMarked: true });
    // The undo record learned it: undoing the combine takes the mark back too.
    expect((await undoCombine(prisma, managed.id)).ok).toBe(true);
    expect(await prisma.setting.findUnique({ where: { key: INTERNAL_MOVES_KEY } })).toBeNull();
  });

  it('marks nothing when two arrivals could be it', async () => {
    const prisma = await freshDatabase();
    const { old, managed } = await seedArrivalOnly(prisma);
    await prisma.transaction.create({
      data: {
        accountId: managed.id, externalId: 'm2', date: day(3), amount: 1190, description: 'TRANSFERRED FROM VS 000-000000-2 (Cash)',
        normalizedMerchant: 'transfer', flow: 'TRANSFER', categorySource: 'AGGREGATOR', source: 'SIMPLEFIN',
      },
    });
    expect((await planCombine(prisma, old.id, managed.id)).internalMove).toBeNull();
  });
});
