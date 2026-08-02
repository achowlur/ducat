import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Connector, NormalizedAccount, NormalizedTransaction } from '../../types/contracts';
import { PrismaClient } from '../../generated/prisma/client';
import { applyRules, type RuleData, type RuleTxn } from './rules';
import { runSync } from './sync';
import { detectTransferPairs } from './transfers';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

describe('applyRules', () => {
  const rule = (partial: Partial<RuleData>): RuleData => ({
    id: 'r1', priority: 10, matchField: 'MERCHANT', matchOperator: 'CONTAINS',
    matchValue: 'netflix', setCategoryId: 'cat-subs', setFlow: null, enabled: true,
    ...partial,
  });
  const txn = (partial: Partial<RuleTxn>): RuleTxn => ({
    id: 't1', amount: -15.99, description: 'NETFLIX.COM', normalizedMerchant: 'netflix',
    accountName: 'Checking', categorySource: 'AGGREGATOR',
    ...partial,
  });

  it('applies the highest-priority (lowest number) matching rule', () => {
    const rules = [
      rule({ id: 'low', priority: 20, setCategoryId: 'cat-low' }),
      rule({ id: 'high', priority: 5, setCategoryId: 'cat-high' }),
    ];
    expect(applyRules(rules, [txn({})])).toEqual([
      { txnId: 't1', ruleId: 'high', categoryId: 'cat-high', flow: null },
    ]);
  });

  it('never touches MANUAL categorizations and skips disabled rules', () => {
    expect(applyRules([rule({})], [txn({ categorySource: 'MANUAL' })])).toEqual([]);
    expect(applyRules([rule({ enabled: false })], [txn({})])).toEqual([]);
  });

  it('supports AMOUNT comparisons against the signed amount', () => {
    const bigSpend = rule({ matchField: 'AMOUNT', matchOperator: 'LT', matchValue: '-500', setCategoryId: 'cat-big' });
    expect(applyRules([bigSpend], [txn({ amount: -900 })])).toHaveLength(1);
    expect(applyRules([bigSpend], [txn({ amount: -100 })])).toHaveLength(0);
  });

  // Banks pad descriptions into fixed columns ("ZELLE TO  JANE DOE", "WF Credit
  // Card   AUTO PAY") while every payee string the app derives has its runs
  // collapsed. Matching literally meant a rule the user had just created
  // silently matched nothing.
  it('matches across bank column padding in the description', () => {
    const r = rule({ matchField: 'DESCRIPTION', matchValue: 'zelle to jane doe', setCategoryId: 'cat-dining' });
    const padded = txn({ description: 'ZELLE TO  JANE DOE ON 07/18 REF # WFCT0000000C' });
    expect(applyRules([r], [padded])[0]?.categoryId).toBe('cat-dining');
  });

  it('still refuses a genuinely different payee', () => {
    const r = rule({ matchField: 'DESCRIPTION', matchValue: 'zelle to jane doe', setCategoryId: 'cat-dining' });
    expect(applyRules([r], [txn({ description: 'ZELLE TO  SMITH JOHN ON 07/19' })])).toEqual([]);
  });

  it('survives malformed user regexes', () => {
    expect(applyRules([rule({ matchOperator: 'REGEX', matchValue: '(' })], [txn({})])).toEqual([]);
  });

  it('can set flow (e.g. force TRANSFER for a known internal payee)', () => {
    const r = rule({ setFlow: 'TRANSFER' });
    expect(applyRules([r], [txn({})])[0].flow).toBe('TRANSFER');
  });

  // Same-account movements (a dividend reinvestment) have no counterparty for
  // transfer-pair detection to find, so classification is the only thing that
  // can keep them out of spending — and they carry no category by convention.
  it('supports flow-only rules that set no category', () => {
    const r = rule({ setCategoryId: null, setFlow: 'TRANSFER' });
    expect(applyRules([r], [txn({})])[0]).toMatchObject({ categoryId: null, flow: 'TRANSFER' });
  });
});

describe('detectTransferPairs', () => {
  const cand = (id: string, accountId: string, date: Date, amount: number) => ({
    id, accountId, date, amount, transferPairId: null,
  });

  it('pairs exact opposite amounts across accounts within the window', () => {
    const pairs = detectTransferPairs([
      cand('out', 'checking', utc(2026, 7, 3), -500),
      cand('in', 'savings', utc(2026, 7, 4), 500),
    ]);
    expect(pairs).toEqual([{ outId: 'out', inId: 'in' }]);
  });

  it('refuses same-account, amount-mismatched, and out-of-window pairs', () => {
    expect(detectTransferPairs([
      cand('a', 'checking', utc(2026, 7, 3), -500),
      cand('b', 'checking', utc(2026, 7, 3), 500),
    ])).toEqual([]);
    expect(detectTransferPairs([
      cand('a', 'checking', utc(2026, 7, 3), -500),
      cand('b', 'savings', utc(2026, 7, 3), 500.01),
    ])).toEqual([]);
    expect(detectTransferPairs([
      cand('a', 'checking', utc(2026, 7, 1), -500),
      cand('b', 'savings', utc(2026, 7, 9), 500),
    ])).toEqual([]);
  });

  it('greedily prefers the nearest date and pairs each side once', () => {
    const pairs = detectTransferPairs([
      cand('out1', 'checking', utc(2026, 7, 3), -500),
      cand('in-far', 'savings', utc(2026, 7, 6), 500),
      cand('in-near', 'savings', utc(2026, 7, 3), 500),
    ]);
    expect(pairs).toEqual([{ outId: 'out1', inId: 'in-near' }]);
  });
});

describe('runSync integration', () => {
  let dir: string;
  let prisma: PrismaClient;

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

  const accounts: NormalizedAccount[] = [
    {
      externalId: 'ext-checking', connectorType: 'SIMPLEFIN', institution: 'Test Bank',
      name: 'Checking', type: 'DEPOSITORY', currency: 'USD',
      balance: 4000, balanceDate: utc(2026, 7, 12), isStale: false,
    },
    {
      externalId: 'ext-savings', connectorType: 'SIMPLEFIN', institution: 'Test Bank',
      name: 'Savings', type: 'DEPOSITORY', currency: 'USD',
      balance: 9000, balanceDate: utc(2026, 7, 12), isStale: false,
    },
  ];
  const txn = (
    acct: string, externalId: string, date: Date, amount: number, merchant: string,
  ): NormalizedTransaction => ({
    accountExternalId: acct, externalId, date, amount,
    description: merchant.toUpperCase(), normalizedMerchant: merchant,
    flow: amount >= 0 ? 'INFLOW' : 'OUTFLOW', source: 'SIMPLEFIN',
  });
  const transactions = [
    txn('ext-checking', 't-salary', utc(2026, 7, 1), 3000, 'employer'),
    txn('ext-checking', 't-netflix', utc(2026, 7, 10), -15.99, 'netflix'),
    txn('ext-checking', 't-xfer-out', utc(2026, 7, 3), -500, 'transfer to savings'),
    txn('ext-savings', 't-xfer-in', utc(2026, 7, 4), 500, 'transfer from checking'),
  ];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ducat-sync-test-'));
    const url = `file:${join(dir, 'test.db').replace(/\\/g, '/')}`;
    const factory = new PrismaBetterSqlite3({ url });
    const conn = await factory.connect();
    const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
    for (const name of readdirSync(migrationsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      await conn.executeScript(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
    }
    await conn.dispose();
    prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

    const subs = await prisma.category.create({ data: { name: 'Subscriptions' } });
    await prisma.rule.create({
      data: {
        priority: 10, matchField: 'MERCHANT', matchOperator: 'CONTAINS',
        matchValue: 'netflix', setCategoryId: subs.id, enabled: true,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('imports everything through the full pipeline', async () => {
    const result = await runSync(prisma, new FakeConnector(accounts, transactions), { since: utc(2026, 6, 1) });

    expect(result.accountsCreated).toBe(2);
    expect(result.transactionsImported).toBe(4);
    expect(result.snapshotsWritten).toBe(2);
    expect(result.rulesApplied).toBe(1);
    expect(result.transfersLinked).toBe(1);
    expect(result.insights?.created).toBeGreaterThan(0);

    const netflix = await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-netflix' } });
    expect(netflix.categorySource).toBe('RULE');

    const out = await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-xfer-out' } });
    const inn = await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-xfer-in' } });
    expect(out.flow).toBe('TRANSFER');
    expect(out.transferPairId).toBe(inn.id);
    expect(inn.transferPairId).toBe(out.id);

    expect(await prisma.setting.findUnique({ where: { key: 'lastSync:SIMPLEFIN' } })).not.toBeNull();
  });

  it('persists a SyncLog on success and on failure', async () => {
    const okLogs = await prisma.syncLog.findMany({ where: { ok: true } });
    expect(okLogs.length).toBeGreaterThan(0);

    class BrokenConnector implements Connector {
      readonly type = 'SIMPLEFIN';
      listAccounts(): Promise<NormalizedAccount[]> {
        return Promise.reject(new Error('feed exploded'));
      }
      fetchTransactions(): Promise<NormalizedTransaction[]> {
        return Promise.resolve([]);
      }
      feedWarnings(): string[] {
        return ['Connection to Test Bank may need attention'];
      }
    }
    await expect(runSync(prisma, new BrokenConnector())).rejects.toThrow('feed exploded');

    const failed = await prisma.syncLog.findFirstOrThrow({ where: { ok: false } });
    expect(failed.errorText).toBe('feed exploded');
    expect(failed.feedErrors).toEqual(['Connection to Test Bank may need attention']);
  });

  it('re-sync is idempotent: nothing duplicated, accounts updated in place', async () => {
    const result = await runSync(prisma, new FakeConnector(accounts, transactions), { since: utc(2026, 6, 1) });
    expect(result.accountsCreated).toBe(0);
    expect(result.accountsUpdated).toBe(2);
    expect(result.transactionsImported).toBe(0);
    expect(result.transactionsSkipped).toBe(4);
    expect(await prisma.transaction.count()).toBe(4);
    // Transfer pair intact, not re-linked or duplicated
    const out = await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-xfer-out' } });
    expect(out.flow).toBe('TRANSFER');
    expect(result.transfersLinked).toBe(0);
  });

  // A CSV backfill targets an account a live connector already owns (same
  // externalId, different connectorType). It must fill in history WITHOUT
  // forking a second copy of the account or overwriting the live balance —
  // a no-balance-column export reports 0/isStale, which would zero net worth.
  it('backfills a CSV import into an existing account without clobbering it', async () => {
    class CsvBackfill implements Connector {
      readonly type = 'CSV';
      listAccounts(): Promise<NormalizedAccount[]> {
        return Promise.resolve([
          {
            externalId: 'ext-checking', connectorType: 'CSV', institution: 'Typo Bank',
            name: 'Renamed By Import', type: 'DEPOSITORY', currency: 'USD',
            balance: 0, balanceDate: utc(2026, 1, 31), isStale: true,
          },
        ]);
      }
      fetchTransactions(): Promise<NormalizedTransaction[]> {
        return Promise.resolve([
          { ...txn('ext-checking', 'csv-old-1', utc(2026, 2, 3), -42, 'old coffee'), source: 'CSV' },
        ]);
      }
    }

    const before = await prisma.account.findFirstOrThrow({ where: { externalId: 'ext-checking' } });
    const result = await runSync(prisma, new CsvBackfill(), { since: new Date(0) });

    expect(result.accountsCreated).toBe(0); // merged, not duplicated
    expect(await prisma.account.count({ where: { externalId: 'ext-checking' } })).toBe(1);

    const after = await prisma.account.findFirstOrThrow({ where: { externalId: 'ext-checking' } });
    expect(Number(after.balance)).toBe(Number(before.balance)); // live balance survives
    expect(after.name).toBe(before.name); // identity not renamed by the import
    expect(after.institution).toBe(before.institution);
    expect(after.connectorType).toBe('SIMPLEFIN'); // still owned by the live feed

    const backfilled = await prisma.transaction.findFirstOrThrow({ where: { externalId: 'csv-old-1' } });
    expect(backfilled.accountId).toBe(before.id); // history landed in the same account
  });

  // The FRED rate fetch rides the pipeline just before insight regeneration.
  // Two contracts: absent key means NO network call at all (the gate fails
  // closed), and a failing fetch NEVER fails the sync — it records itself in
  // the Setting the fetcher owns and the pipeline finishes green.
  describe('mortgage-rate fetch riding the sync', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('makes no fetch at all without FRED_API_KEY', async () => {
      vi.stubEnv('FRED_API_KEY', '');
      const spy = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', spy);
      const result = await runSync(prisma, new FakeConnector(accounts, transactions), {
        since: utc(2026, 6, 1),
      });
      expect(result.insights).not.toBeNull();
      expect(spy).not.toHaveBeenCalled();
      expect(await prisma.setting.findUnique({ where: { key: 'rates.mortgage' } })).toBeNull();
    });

    it('a failing rate fetch records itself and leaves the sync green', async () => {
      vi.stubEnv('FRED_API_KEY', 'test-key');
      const failing = vi.fn<typeof fetch>(() => Promise.reject(new Error('network down')));
      vi.stubGlobal('fetch', failing);
      const result = await runSync(prisma, new FakeConnector(accounts, transactions), {
        since: utc(2026, 6, 1),
      });
      expect(result.insights).not.toBeNull(); // pipeline completed
      expect(failing).toHaveBeenCalledTimes(1);
      const row = await prisma.setting.findUniqueOrThrow({ where: { key: 'rates.mortgage' } });
      const stored = JSON.parse(row.value) as {
        observation: unknown;
        lastError: { message: string } | null;
      };
      expect(stored.observation).toBeNull();
      expect(stored.lastError?.message).toContain('network down');
      const log = await prisma.syncLog.findFirstOrThrow({ orderBy: { finishedAt: 'desc' } });
      expect(log.ok).toBe(true); // the failure never reached the SyncLog
    });

    it('skipInsights also skips the rate fetch — batched imports fetch once at the end', async () => {
      vi.stubEnv('FRED_API_KEY', 'test-key');
      const spy = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', spy);
      await runSync(prisma, new FakeConnector(accounts, transactions), {
        since: utc(2026, 6, 1),
        skipInsights: true,
      });
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
