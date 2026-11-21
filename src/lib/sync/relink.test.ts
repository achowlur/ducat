import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Connector, NormalizedAccount, NormalizedTransaction } from '../../types/contracts';
import { PrismaClient } from '../../generated/prisma/client';
import { CASH_ACCOUNTS_KEY } from '../ui/liquidity';
import {
  applyRelink,
  currentRelinkPairs,
  dismissRelinkPair,
  findRelinkPairs,
  planRelink,
  undoRelink,
  type RelinkAccount,
} from './relink';
import { runSync } from './sync';

/**
 * A reconnect at the aggregator hands the same real account back under a new
 * id. Invented accounts and figures throughout.
 */

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

const dirs: string[] = [];
const clients: PrismaClient[] = [];

async function freshDatabase(): Promise<PrismaClient> {
  const dir = mkdtempSync(join(tmpdir(), 'ducat-relink-'));
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

class FakeConnector implements Connector {
  readonly type = 'SIMPLEFIN';
  constructor(
    private accounts: NormalizedAccount[],
    private txns: NormalizedTransaction[],
  ) {}
  listAccounts(): Promise<NormalizedAccount[]> {
    return Promise.resolve(this.accounts);
  }
  fetchTransactions(since: Date): Promise<NormalizedTransaction[]> {
    return Promise.resolve(this.txns.filter((t) => t.date.getTime() >= since.getTime()));
  }
}

const account = (externalId: string, name: string, balance: number): NormalizedAccount => ({
  externalId,
  connectorType: 'SIMPLEFIN',
  institution: 'Example Bank',
  name,
  type: 'DEPOSITORY',
  currency: 'USD',
  balance,
  balanceDate: daysAgo(0),
  isStale: false,
});

const txn = (accountExternalId: string, externalId: string, days: number, amount: number, text: string): NormalizedTransaction => ({
  accountExternalId,
  externalId,
  date: daysAgo(days),
  amount,
  description: text.toUpperCase(),
  normalizedMerchant: text,
  flow: amount >= 0 ? 'INFLOW' : 'OUTFLOW',
  source: 'SIMPLEFIN',
});

describe('findRelinkPairs', () => {
  const at = (days: number) => daysAgo(days);
  const acct = (id: string, externalId: string, name: string, created: number, institution = 'Example Bank'): RelinkAccount => ({
    id,
    externalId,
    connectorType: 'SIMPLEFIN',
    institution,
    name,
    createdAt: at(created),
    balanceDate: at(created),
  });
  const feed = (...ids: string[]) => ({ SIMPLEFIN: { at: at(0).toISOString(), externalIds: ids } });

  it('offers an account the feed stopped listing beside a newer one of the same name', () => {
    const accounts = [acct('a1', 'old', 'Savings (0002)', 60), acct('a2', 'new', 'Savings (0002)', 0), acct('a3', 'chk', 'Checking (0001)', 60)];
    expect(findRelinkPairs(accounts, feed('new', 'chk'), new Set()).map((p) => [p.oldId, p.newId])).toEqual([['a1', 'a2']]);
  });

  it('matches a renamed account by its account number, and a name without one by its words', () => {
    const renamed = [acct('a1', 'old', 'Savings (0002)', 60), acct('a2', 'new', 'Rainy Day Fund (0002)', 0)];
    expect(findRelinkPairs(renamed, feed('new'), new Set()).map((p) => [p.oldId, p.newId])).toEqual([['a1', 'a2']]);
    const bare = [acct('a1', 'old', 'Brokerage', 60), acct('a2', 'new', 'Brokerage', 0)];
    expect(findRelinkPairs(bare, feed('new'), new Set())).toHaveLength(1);
    expect(findRelinkPairs([bare[0], acct('a2', 'new', 'Retirement', 0)], feed('new'), new Set())).toEqual([]);
  });

  it('offers nothing it cannot be sure of', () => {
    const base = [acct('a1', 'old', 'Savings (0002)', 60), acct('a2', 'new', 'Savings (0002)', 0)];
    // The old account is still listed: two real accounts, not a fork.
    expect(findRelinkPairs(base, feed('old', 'new'), new Set())).toEqual([]);
    // Other trailing digits, another institution, or a newer "old" one.
    expect(findRelinkPairs([base[0], acct('a2', 'new', 'Savings (0003)', 0)], feed('new'), new Set())).toEqual([]);
    expect(findRelinkPairs([base[0], acct('a2', 'new', 'Savings (0002)', 0, 'Other Bank')], feed('new'), new Set())).toEqual([]);
    expect(findRelinkPairs([acct('a1', 'old', 'Savings (0002)', 0), acct('a2', 'new', 'Savings (0002)', 60)], feed('new'), new Set())).toEqual([]);
    // Two candidates either way.
    expect(findRelinkPairs([...base, acct('a4', 'older', 'Savings (0002)', 90)], feed('new'), new Set())).toEqual([]);
    expect(findRelinkPairs([...base, acct('a5', 'newer', 'Savings (0002)', 0)], feed('new', 'newer'), new Set())).toEqual([]);
    // Dismissed, a statement-only connector, or no feed on record.
    expect(findRelinkPairs(base, feed('new'), new Set(['a1|a2']))).toEqual([]);
    expect(findRelinkPairs(base.map((a) => ({ ...a, connectorType: 'CSV' })), { CSV: feed('new').SIMPLEFIN }, new Set())).toEqual([]);
    expect(findRelinkPairs(base, {}, new Set())).toEqual([]);
  });
});

describe('a reconnect, merged and undone', () => {
  it('drops the copies, keeps every hand decision, adopts the new ids and stays deduped', async () => {
    const prisma = await freshDatabase();
    const checking = account('chk', 'Checking (0001)', 900);
    const savingsBefore = account('sav-old', 'Savings (0002)', 1500);
    const firstFeed = [
      txn('chk', 'c1', 20, -500, 'online transfer to savings'),
      txn('sav-old', 's1', 20, 500, 'online transfer from checking'),
      txn('sav-old', 's2', 10, 12.5, 'interest payment'),
      txn('sav-old', 's3', 5, -40, 'atm withdrawal'),
    ];
    await runSync(prisma, new FakeConnector([checking, savingsBefore], firstFeed));
    const oldSavings = await prisma.account.findFirstOrThrow({ where: { externalId: 'sav-old' } });
    // A decision made by hand on the old account, which no copy may override.
    const category = await prisma.category.create({ data: { name: 'Cash' } });
    const atm = await prisma.transaction.findFirstOrThrow({ where: { externalId: 's3' } });
    await prisma.transaction.update({ where: { id: atm.id }, data: { categoryId: category.id, categorySource: 'MANUAL' } });

    // The reconnect: the same savings account under a new id, its history re-sent under new row ids.
    await new Promise((r) => setTimeout(r, 5));
    const savingsAfter = account('sav-new', 'Savings (0002)', 1600);
    const resent = [
      txn('sav-new', 'n1', 20, 500, 'online transfer from checking'),
      txn('sav-new', 'n2', 10, 12.5, 'interest payment'),
      txn('sav-new', 'n3', 5, -40, 'atm withdrawal'),
      txn('sav-new', 'n4', 1, 100, 'mobile deposit'),
    ];
    await runSync(prisma, new FakeConnector([checking, savingsAfter], [...firstFeed.filter((t) => t.accountExternalId === 'chk'), ...resent]), {
      since: daysAgo(30),
    });
    expect(await prisma.account.count()).toBe(3);
    const newSavings = await prisma.account.findFirstOrThrow({ where: { externalId: 'sav-new' } });
    // The user marked the new copy as cash before noticing the fork.
    await prisma.setting.create({ data: { key: CASH_ACCOUNTS_KEY, value: JSON.stringify([newSavings.id]) } });

    const pairs = await currentRelinkPairs(prisma);
    expect(pairs.map((p) => [p.oldId, p.newId])).toEqual([[oldSavings.id, newSavings.id]]);
    const plan = await planRelink(prisma, oldSavings.id, newSavings.id);
    expect(plan.duplicates).toHaveLength(3);
    expect(plan.move).toHaveLength(1);
    expect(plan.ambiguous).toHaveLength(0);

    const merged = await applyRelink(prisma, oldSavings.id, newSavings.id);
    expect(merged).toEqual({ ok: true, result: { moved: 1, duplicates: 3, ambiguous: 0, unpaired: 0 } });

    // One savings account again: the old one, live, with its history and the new row.
    expect(await prisma.account.count()).toBe(2);
    const kept = await prisma.account.findUniqueOrThrow({ where: { id: oldSavings.id } });
    expect(kept.externalId).toBe('sav-new');
    expect(Number(kept.balance)).toBe(1600);
    const rows = await prisma.transaction.findMany({ where: { accountId: oldSavings.id }, orderBy: { date: 'asc' } });
    expect(rows.map((r) => r.externalId)).toEqual(['n1', 'n2', 'n3', 'n4']);
    const keptAtm = rows.find((r) => r.externalId === 'n3')!;
    expect(keptAtm.id).toBe(atm.id);
    expect(keptAtm.categorySource).toBe('MANUAL');
    expect(keptAtm.categoryId).toBe(category.id);
    // The transfer pair made on the first sync still stands.
    const transfer = rows.find((r) => r.externalId === 'n1')!;
    const out = await prisma.transaction.findFirstOrThrow({ where: { externalId: 'c1' } });
    expect(transfer.transferPairId).toBe(out.id);
    expect(out.transferPairId).toBe(transfer.id);
    // The setting follows the account it meant.
    const cash = await prisma.setting.findUniqueOrThrow({ where: { key: CASH_ACCOUNTS_KEY } });
    expect(JSON.parse(cash.value)).toEqual([oldSavings.id]);
    expect(await currentRelinkPairs(prisma)).toEqual([]);

    // The next sync re-sends the same week under the new ids: nothing doubles.
    await runSync(prisma, new FakeConnector([checking, savingsAfter], [...firstFeed.filter((t) => t.accountExternalId === 'chk'), ...resent]), {
      since: daysAgo(30),
    });
    expect(await prisma.account.count()).toBe(2);
    expect(await prisma.transaction.count({ where: { accountId: oldSavings.id } })).toBe(4);
  });

  it("moves a transfer link the copy won to the kept row, and unpairs rather than overrule a hand decision", async () => {
    const prisma = await freshDatabase();
    const checking = account('chk', 'Checking (0001)', 900);
    // The old account holds both deposits; the checking side of them arrives only after the reconnect.
    await runSync(prisma, new FakeConnector([checking, account('sav-old', 'Savings (0002)', 1500)], [
      txn('sav-old', 's1', 6, 300, 'online transfer from checking'),
      txn('sav-old', 's2', 5, 200, 'online transfer from checking'),
    ]));
    const decided = await prisma.transaction.findFirstOrThrow({ where: { externalId: 's2' } });
    const category = await prisma.category.create({ data: { name: 'Gifts' } });
    await prisma.transaction.update({ where: { id: decided.id }, data: { categoryId: category.id, categorySource: 'MANUAL' } });
    await new Promise((r) => setTimeout(r, 5));
    // After the reconnect the copies arrive with the checking side, and pairing links each copy.
    await runSync(prisma, new FakeConnector([checking, account('sav-new', 'Savings (0002)', 1500)], [
      txn('chk', 'c1', 6, -300, 'online transfer to savings'),
      txn('chk', 'c2', 5, -200, 'online transfer to savings'),
      txn('sav-new', 'n1', 6, 300, 'online transfer from checking'),
      txn('sav-new', 'n2', 5, 200, 'online transfer from checking'),
    ]), { since: daysAgo(30) });
    const [pair] = await currentRelinkPairs(prisma);
    const merged = await applyRelink(prisma, pair.oldId, pair.newId);
    expect(merged).toEqual({ ok: true, result: { moved: 0, duplicates: 2, ambiguous: 0, unpaired: 1 } });

    const c1 = await prisma.transaction.findFirstOrThrow({ where: { externalId: 'c1' } });
    const s1 = await prisma.transaction.findFirstOrThrow({ where: { externalId: 'n1' } });
    expect(s1.accountId).toBe(pair.oldId);
    expect(c1.transferPairId).toBe(s1.id);
    expect(s1.transferPairId).toBe(c1.id);
    expect(s1.flow).toBe('TRANSFER');
    // The hand-categorized deposit stays as decided; its partner is left without a pair, and counted.
    const s2 = await prisma.transaction.findUniqueOrThrow({ where: { id: decided.id } });
    expect([s2.categorySource, s2.categoryId, s2.transferPairId]).toEqual(['MANUAL', category.id, null]);
    const c2 = await prisma.transaction.findFirstOrThrow({ where: { externalId: 'c2' } });
    expect(c2.transferPairId).toBeNull();
  });

  it('puts a merge back exactly, and refuses once a sync has run since', async () => {
    const prisma = await freshDatabase();
    const first = [txn('sav-old', 's1', 10, 25, 'interest payment'), txn('sav-old', 's2', 4, -60, 'atm withdrawal')];
    await runSync(prisma, new FakeConnector([account('sav-old', 'Savings (0002)', 800)], first));
    await new Promise((r) => setTimeout(r, 5));
    const second = [txn('sav-new', 'n1', 10, 25, 'interest payment'), txn('sav-new', 'n2', 4, -60, 'atm withdrawal'), txn('sav-new', 'n3', 1, 10, 'refund')];
    await runSync(prisma, new FakeConnector([account('sav-new', 'Savings (0002)', 810)], second), { since: daysAgo(30) });

    const snapshot = async () => ({
      accounts: (await prisma.account.findMany({ orderBy: { id: 'asc' } })).map((a) => [a.id, a.externalId, Number(a.balance)]),
      rows: (await prisma.transaction.findMany({ orderBy: { id: 'asc' } })).map((t) => [t.id, t.accountId, t.externalId, t.flow, t.categoryId]),
      snapshots: (await prisma.balanceSnapshot.findMany({ orderBy: { id: 'asc' } })).map((s) => [s.id, s.accountId, s.date.getTime()]),
    });
    const before = await snapshot();
    const [pair] = await currentRelinkPairs(prisma);
    expect((await applyRelink(prisma, pair.oldId, pair.newId)).ok).toBe(true);
    expect(await undoRelink(prisma, pair.oldId)).toEqual({ ok: true });
    expect(await snapshot()).toEqual(before);
    expect((await currentRelinkPairs(prisma)).map((p) => p.newId)).toEqual([pair.newId]);

    expect((await applyRelink(prisma, pair.oldId, pair.newId)).ok).toBe(true);
    await runSync(prisma, new FakeConnector([account('sav-new', 'Savings (0002)', 810)], second), { since: daysAgo(30) });
    const refused = await undoRelink(prisma, pair.oldId);
    expect(refused.ok).toBe(false);
  });

  it('refuses a pair that is no longer offered, and never offers a dismissed one again', async () => {
    const prisma = await freshDatabase();
    await runSync(prisma, new FakeConnector([account('sav-old', 'Savings (0002)', 800)], []));
    await new Promise((r) => setTimeout(r, 5));
    await runSync(prisma, new FakeConnector([account('sav-new', 'Savings (0002)', 810)], []));
    const [pair] = await currentRelinkPairs(prisma);
    await dismissRelinkPair(prisma, pair.oldId, pair.newId);
    expect(await currentRelinkPairs(prisma)).toEqual([]);
    const refused = await applyRelink(prisma, pair.oldId, pair.newId);
    expect(refused.ok).toBe(false);
    expect(await prisma.account.count()).toBe(2);
  });
});
