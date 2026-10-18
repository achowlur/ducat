import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connector, NormalizedAccount, NormalizedTransaction } from '../../types/contracts';
import { PrismaClient } from '../../generated/prisma/client';
import { shortDate } from '../ui/format';
import { SYNC_LOCK_KEY, SyncAlreadyRunningError } from './lock';
import { runSync } from './sync';

/**
 * What a sync does when it is not alone, not finished, or asked for more
 * history than its feed holds. Each block below failed on the pipeline as it
 * was: two runs collided on the dedupe unique, a run killed after its insert
 * left rows uncategorized for good, and a window past the feed's reach was
 * narrowed by the feed without a word.
 */

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

const dirs: string[] = [];
const clients: PrismaClient[] = [];

async function freshDatabase(): Promise<PrismaClient> {
  const dir = mkdtempSync(join(tmpdir(), 'ducat-sync-safety-'));
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
    readonly maxHistoryDays?: number,
  ) {}
  listAccounts(): Promise<NormalizedAccount[]> {
    return Promise.resolve(this.accounts);
  }
  fetchTransactions(since: Date): Promise<NormalizedTransaction[]> {
    return Promise.resolve(this.txns.filter((t) => t.date.getTime() >= since.getTime()));
  }
}

const checking: NormalizedAccount = {
  externalId: 'ext-checking', connectorType: 'SIMPLEFIN', institution: 'Test Bank',
  name: 'Checking', type: 'DEPOSITORY', currency: 'USD',
  balance: 2500, balanceDate: daysAgo(1), isStale: false,
};

const txn = (externalId: string, date: Date, amount: number, merchant: string): NormalizedTransaction => ({
  accountExternalId: 'ext-checking', externalId, date, amount,
  description: merchant.toUpperCase(), normalizedMerchant: merchant,
  flow: amount >= 0 ? 'INFLOW' : 'OUTFLOW', source: 'SIMPLEFIN',
});

const feed = [
  txn('t-stream-1', daysAgo(20), -11.37, 'streamco'),
  txn('t-stream-2', daysAgo(10), -11.37, 'streamco'),
  txn('t-grocer-1', daysAgo(8), -41.2, 'corner grocer'),
  txn('t-grocer-2', daysAgo(3), -27.85, 'corner grocer'),
  txn('t-unknown', daysAgo(2), -9, 'mystery shop'),
];

async function withRules(prisma: PrismaClient): Promise<{ subs: string; groceries: string }> {
  const subs = await prisma.category.create({ data: { name: 'Subscriptions' } });
  const groceries = await prisma.category.create({ data: { name: 'Groceries' } });
  for (const [value, categoryId] of [['streamco', subs.id], ['corner grocer', groceries.id]] as const) {
    await prisma.rule.create({
      data: { priority: 10, matchField: 'MERCHANT', matchOperator: 'CONTAINS', matchValue: value, setCategoryId: categoryId, enabled: true },
    });
  }
  return { subs: subs.id, groceries: groceries.id };
}

/**
 * A client whose `rule.findMany` throws the first time: the shape of a run the
 * host killed between the insert and the rules (maxDuration is 60s, and the
 * insert is the step that grows with history).
 */
function killedAfterInsert(prisma: PrismaClient): PrismaClient {
  let killed = false;
  const rule = new Proxy(prisma.rule, {
    get(target, prop, receiver) {
      if (prop === 'findMany' && !killed) {
        return () => {
          killed = true;
          return Promise.reject(new Error('Task timed out after 60 seconds'));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      return prop === 'rule' ? rule : Reflect.get(target, prop, receiver);
    },
  });
}

/** A client that counts per-row `transaction.update` calls. */
function countingUpdates(prisma: PrismaClient): { client: PrismaClient; updates: () => number } {
  let updates = 0;
  const transaction = new Proxy(prisma.transaction, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'update') return value;
      return (...args: Parameters<typeof target.update>) => {
        updates += 1;
        return target.update(...args);
      };
    },
  });
  const client = new Proxy(prisma, {
    get(target, prop, receiver) {
      return prop === 'transaction' ? transaction : Reflect.get(target, prop, receiver);
    },
  });
  return { client, updates: () => updates };
}

describe('runSync: two runs at once', () => {
  let prisma: PrismaClient;
  beforeEach(async () => {
    prisma = await freshDatabase();
  });

  async function bothAtOnce(): Promise<PromiseSettledResult<unknown>[]> {
    // The feed's answer takes seconds, so the cron and a tap on "Sync now"
    // are both waiting on it at once: neither has inserted when the other
    // checks what is already stored. Each fetch here waits for the other's.
    let arrived = 0;
    let open: () => void = () => undefined;
    const bothFetching = new Promise<void>((resolve) => {
      open = resolve;
    });
    class SlowFeed extends FakeConnector {
      async fetchTransactions(since: Date): Promise<NormalizedTransaction[]> {
        arrived += 1;
        if (arrived === 2) open();
        await Promise.race([bothFetching, new Promise((resolve) => setTimeout(resolve, 500))]);
        return super.fetchTransactions(since);
      }
    }
    const since = daysAgo(30);
    return Promise.allSettled([
      runSync(prisma, new SlowFeed([checking], feed), { since, skipInsights: true }),
      runSync(prisma, new SlowFeed([checking], feed), { since, skipInsights: true }),
    ]);
  }

  it('lets one run import and refuses the other by name, instead of colliding on the dedupe unique', async () => {
    // The account is already known (any sync after the first): both runs map
    // the feed's rows to the same account, and both insert the same keys.
    await runSync(prisma, new FakeConnector([checking], []), { since: daysAgo(30), skipInsights: true });
    const results = await bothAtOnce();

    const done = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(done).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(SyncAlreadyRunningError);
    expect(String(refused[0].reason.message)).toMatch(/already running/);
    expect(await prisma.transaction.count()).toBe(feed.length);

    // The refusal is not a failed sync: health reads SyncLog, and a run that
    // never started must not show there as one that broke.
    expect(await prisma.syncLog.count({ where: { ok: false } })).toBe(0);
    // And the winner let go of the lock.
    expect(await prisma.setting.findUnique({ where: { key: SYNC_LOCK_KEY } })).toBeNull();
  });

  it('never forks the account on a first sync run twice at once', async () => {
    // With no account stored yet, both runs used to create one: two copies of
    // the same real account, each holding every row, doubling net worth.
    await bothAtOnce();
    expect(await prisma.account.count()).toBe(1);
    expect(await prisma.transaction.count()).toBe(feed.length);
  });

  it('releases the lock when a run fails, so the next one is not refused', async () => {
    class Broken extends FakeConnector {
      listAccounts(): Promise<NormalizedAccount[]> {
        return Promise.reject(new Error('feed exploded'));
      }
    }
    await expect(runSync(prisma, new Broken([checking], feed), { skipInsights: true })).rejects.toThrow('feed exploded');
    const result = await runSync(prisma, new FakeConnector([checking], feed), { since: daysAgo(30), skipInsights: true });
    expect(result.transactionsImported).toBe(feed.length);
  });

  it('takes over a lock left by a run that was killed and never let go', async () => {
    await prisma.setting.create({ data: { key: SYNC_LOCK_KEY, value: `${daysAgo(1).toISOString()}|killed-run` } });
    const result = await runSync(prisma, new FakeConnector([checking], feed), { since: daysAgo(30), skipInsights: true });
    expect(result.transactionsImported).toBe(feed.length);
  });

  it('refuses while a live lock is held', async () => {
    const expires = new Date(Date.now() + 60_000).toISOString();
    await prisma.setting.create({ data: { key: SYNC_LOCK_KEY, value: `${expires}|other-run` } });
    await expect(
      runSync(prisma, new FakeConnector([checking], feed), { since: daysAgo(30), skipInsights: true }),
    ).rejects.toBeInstanceOf(SyncAlreadyRunningError);
    expect(await prisma.transaction.count()).toBe(0);
    // Someone else's lock is left exactly as it was.
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: SYNC_LOCK_KEY } })).value).toBe(`${expires}|other-run`);
  });
});

describe('runSync: a run killed between the insert and the rules', () => {
  let prisma: PrismaClient;
  let ids: { subs: string; groceries: string };
  beforeEach(async () => {
    prisma = await freshDatabase();
    ids = await withRules(prisma);
  });

  it('is finished by the next run: rows it stranded get their rules', async () => {
    const since = daysAgo(30);
    await expect(
      runSync(killedAfterInsert(prisma), new FakeConnector([checking], feed), { since, skipInsights: true }),
    ).rejects.toThrow('timed out');
    // The insert landed and the rules did not: the stranded state.
    expect(await prisma.transaction.count({ where: { categoryId: null } })).toBe(feed.length);

    // Every row is already stored, so none is "fresh" to the next run.
    const rerun = await runSync(prisma, new FakeConnector([checking], feed), { since, skipInsights: true });
    expect(rerun.transactionsImported).toBe(0);
    expect(rerun.rulesApplied).toBe(4);

    const rows = await prisma.transaction.findMany({ orderBy: { externalId: 'asc' } });
    const byId = Object.fromEntries(rows.map((r) => [r.externalId, r]));
    expect(byId['t-stream-1'].categoryId).toBe(ids.subs);
    expect(byId['t-stream-2'].categoryId).toBe(ids.subs);
    expect(byId['t-grocer-1'].categoryId).toBe(ids.groceries);
    expect(byId['t-grocer-2'].categorySource).toBe('RULE');
    expect(byId['t-unknown'].categoryId).toBeNull();
  });

  it('never touches a MANUAL row, even an uncategorized one', async () => {
    await runSync(killedAfterInsert(prisma), new FakeConnector([checking], feed), { since: daysAgo(30), skipInsights: true }).catch(() => undefined);
    // The operator looked at one stranded row and decided it has no category.
    await prisma.transaction.updateMany({ where: { externalId: 't-stream-1' }, data: { categorySource: 'MANUAL' } });

    await runSync(prisma, new FakeConnector([checking], feed), { since: daysAgo(30), skipInsights: true });
    const manual = await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-stream-1' } });
    expect(manual.categorySource).toBe('MANUAL');
    expect(manual.categoryId).toBeNull();
  });

  it('leaves a transfer pair alone: its category was cleared on purpose', async () => {
    const savings: NormalizedAccount = { ...checking, externalId: 'ext-savings', name: 'Savings' };
    const out = txn('t-move-out', daysAgo(5), -300, 'streamco transfer');
    const inn = { ...txn('t-move-in', daysAgo(4), 300, 'transfer in'), accountExternalId: 'ext-savings' };
    const first = await runSync(prisma, new FakeConnector([checking, savings], [out, inn]), { since: daysAgo(30), skipInsights: true });
    expect(first.transfersLinked).toBe(1);

    const again = await runSync(prisma, new FakeConnector([checking, savings], [out, inn]), { since: daysAgo(30), skipInsights: true });
    expect(again.rulesApplied).toBe(0);
    const row = await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-move-out' } });
    expect(row.flow).toBe('TRANSFER');
    expect(row.categoryId).toBeNull();
  });

  it('closes the box on a stranded investment row, and leaves one already closed as it is', async () => {
    const brokerage: NormalizedAccount = { ...checking, externalId: 'ext-brokerage', name: 'Brokerage', type: 'INVESTMENT' };
    const dividend = { ...txn('t-dividend', daysAgo(6), 14.1, 'dividend received'), accountExternalId: 'ext-brokerage' };
    await runSync(killedAfterInsert(prisma), new FakeConnector([brokerage], [dividend]), { since: daysAgo(30), skipInsights: true }).catch(() => undefined);
    expect((await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-dividend' } })).flow).toBe('INFLOW');

    // A row an earlier import stored as a transfer with no category, the
    // shape a CSV flagged by wording leaves: the box would change nothing.
    const account = await prisma.account.findFirstOrThrow({ where: { externalId: 'ext-brokerage' } });
    await prisma.transaction.create({
      data: {
        accountId: account.id, externalId: 't-sweep', date: daysAgo(40), amount: -50, description: 'SWEEP',
        normalizedMerchant: 'sweep', flow: 'TRANSFER', categorySource: 'AGGREGATOR', source: 'CSV',
      },
    });

    const rerun = await runSync(prisma, new FakeConnector([brokerage], [dividend]), { since: daysAgo(30), skipInsights: true });
    expect(rerun.rulesApplied).toBe(1);
    const fixed = await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-dividend' } });
    expect(fixed.flow).toBe('TRANSFER');
    expect(fixed.categorySource).toBe('RULE');
    expect((await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-sweep' } })).categorySource).toBe('AGGREGATOR');
  });

  it('writes rules one category at a time, not one row at a time', async () => {
    const many = Array.from({ length: 30 }, (_, i) => txn(`t-many-${i}`, daysAgo(1 + (i % 20)), -5 - i, i % 2 === 0 ? 'streamco' : 'corner grocer'));
    const { client, updates } = countingUpdates(prisma);
    const result = await runSync(client, new FakeConnector([checking], many), { since: daysAgo(30), skipInsights: true });
    expect(result.rulesApplied).toBe(30);
    expect(updates()).toBe(0);
    expect(await prisma.transaction.count({ where: { categoryId: ids.subs } })).toBe(15);
    expect(await prisma.transaction.count({ where: { categoryId: ids.groceries } })).toBe(15);
  });
});

describe('runSync: a gap longer than the feed reaches back', () => {
  let prisma: PrismaClient;
  beforeEach(async () => {
    prisma = await freshDatabase();
  });

  it('clamps the window to the feed and names the dates it could not fetch', async () => {
    const lastSync = daysAgo(200);
    await prisma.setting.create({ data: { key: 'lastSync:SIMPLEFIN', value: lastSync.toISOString() } });
    const old = txn('t-old', daysAgo(150), -20, 'corner grocer');
    const recent = txn('t-recent', daysAgo(5), -20, 'corner grocer');

    const before = Date.now();
    const result = await runSync(prisma, new FakeConnector([checking], [old, recent], 90), { skipInsights: true });

    // The window asked of the feed is its 90 days, not the 207 the gap implies.
    expect(result.since.getTime()).toBeGreaterThanOrEqual(before - 90 * DAY_MS);
    expect(result.since.getTime()).toBeLessThanOrEqual(Date.now() - 90 * DAY_MS + 1_000);
    expect(result.transactionsImported).toBe(1);

    const wanted = new Date(lastSync.getTime() - 7 * DAY_MS);
    const warning = result.feedWarnings.find((w) => w.includes('could not be fetched'));
    expect(warning).toBeDefined();
    expect(warning).toContain(shortDate(wanted));
    expect(warning).toContain(shortDate(result.since));
    expect(warning).toMatch(/import a CSV/i);
    expect(warning).not.toContain('—');

    // Recorded where /providers reads feed warnings.
    const log = await prisma.syncLog.findFirstOrThrow({ where: { ok: true } });
    expect(log.feedErrors).toContain(warning);
  });

  it('says nothing on a first sync, whose default window is the feed\'s own reach', async () => {
    const result = await runSync(prisma, new FakeConnector([checking], feed, 90), { skipInsights: true });
    expect(result.feedWarnings).toEqual([]);
    expect(result.transactionsImported).toBe(feed.length);
  });

  it('says nothing when the window fits', async () => {
    await prisma.setting.create({ data: { key: 'lastSync:SIMPLEFIN', value: daysAgo(3).toISOString() } });
    const result = await runSync(prisma, new FakeConnector([checking], feed, 90), { skipInsights: true });
    expect(result.feedWarnings).toEqual([]);
  });

  it('leaves an explicit window alone for a connector with no limit (a CSV or statement import)', async () => {
    const since = daysAgo(400);
    const result = await runSync(prisma, new FakeConnector([checking], feed), { since, skipInsights: true });
    expect(result.since.getTime()).toBe(since.getTime());
    expect(result.feedWarnings).toEqual([]);
  });
});
