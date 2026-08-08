import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CsvConnector } from '../connectors/csv';
import { CSV_MAPPINGS } from '../connectors/csvMappings';
import type { Connector, NormalizedAccount, NormalizedTransaction } from '../../types/contracts';
import { PrismaClient } from '../../generated/prisma/client';
import { previewImport } from './previewImport';
import { runSync } from './sync';

/**
 * The preview's whole claim is that it agrees with the import, so the tests
 * that matter run BOTH over the same fixture and compare. A preview that is
 * merely self-consistent is worse than none: it is confidence without
 * evidence, handed to someone about to write rows they cannot take back.
 */

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

const dirs: string[] = [];

async function freshDb(): Promise<PrismaClient> {
  const dir = mkdtempSync(join(tmpdir(), 'ducat-preview-test-'));
  dirs.push(dir);
  const url = `file:${join(dir, 'test.db').replace(/\\/g, '/')}`;
  const factory = new PrismaBetterSqlite3({ url });
  const conn = await factory.connect();
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  const names = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    await conn.executeScript(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
  }
  await conn.dispose();
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

/** Every table, so "wrote nothing" means nothing anywhere — not nothing where we looked. */
async function census(prisma: PrismaClient): Promise<Record<string, number>> {
  return {
    account: await prisma.account.count(),
    balanceSnapshot: await prisma.balanceSnapshot.count(),
    transaction: await prisma.transaction.count(),
    category: await prisma.category.count(),
    rule: await prisma.rule.count(),
    syncLog: await prisma.syncLog.count(),
    trackedSubscription: await prisma.trackedSubscription.count(),
    insight: await prisma.insight.count(),
    setting: await prisma.setting.count(),
  };
}

// Newest-first, the way the real exports arrive. Merchants are invented.
const CHASE_CSV = [
  'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
  'DEBIT,03/14/2025,MERIDIAN COFFEE HOUSE,-17.49,DEBIT_CARD,6252.68,',
  'DEBIT,03/12/2025,NETFLIX.COM,-41.44,ACH_DEBIT,6270.17,',
  'CREDIT,03/01/2025,PAYROLL DIRECT DEP,6479.32,ACH_CREDIT,6311.61,',
  'DEBIT,02/27/2025,MERIDIAN COFFEE HOUSE,-17.49,DEBIT_CARD,-167.71,',
  '',
].join('\n');

const descriptor = (until?: Date) => ({
  externalId: 'ext-checking',
  name: 'Checking',
  institution: 'Test Bank',
  type: 'DEPOSITORY' as const,
  currency: 'USD',
  until,
});

const csvConnector = (until?: Date) =>
  new CsvConnector(CHASE_CSV, { ...CSV_MAPPINGS['chase-checking'], account: undefined }, descriptor(until));

async function seedRule(prisma: PrismaClient): Promise<void> {
  const subs = await prisma.category.create({ data: { name: 'Subscriptions' } });
  await prisma.rule.create({
    data: {
      priority: 10,
      matchField: 'MERCHANT',
      matchOperator: 'CONTAINS',
      matchValue: 'netflix',
      setCategoryId: subs.id,
      enabled: true,
    },
  });
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('previewImport writes nothing', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    prisma = await freshDb();
    await seedRule(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // The failure this guards is a write added to the pipeline later and mirrored
  // here without its guard. A count of the tables the preview "should" touch
  // would not catch it; counting all of them does.
  it('leaves every table exactly as it found it', async () => {
    const before = await census(prisma);
    const preview = await previewImport(prisma, csvConnector(), new Date(0));
    expect(preview.newRows).toBe(4); // it did do the work
    expect(await census(prisma)).toEqual(before);
  });

  // runSync logs EVERY run, success or failure, so a SyncLog row is the tell
  // that the preview reached the pipeline at all.
  it('records no SyncLog and no lastSync Setting', async () => {
    await previewImport(prisma, csvConnector(), new Date(0));
    expect(await prisma.syncLog.count()).toBe(0);
    expect(await prisma.setting.findUnique({ where: { key: 'lastSync:CSV' } })).toBeNull();
  });
});

describe('previewImport agrees with the import it previews', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    prisma = await freshDb();
    await seedRule(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('predicts the counts runSync then reports', async () => {
    const preview = await previewImport(prisma, csvConnector(), new Date(0));
    const result = await runSync(prisma, csvConnector(), { since: new Date(0) });

    expect(preview.newRows).toBe(result.transactionsImported);
    expect(preview.duplicateRows).toBe(result.transactionsSkipped);
    expect(preview.accounts.filter((a) => a.disposition === 'CREATE')).toHaveLength(
      result.accountsCreated,
    );
    expect(preview.accounts.filter((a) => a.disposition !== 'CREATE')).toHaveLength(
      result.accountsUpdated,
    );
    expect(preview.rulesApplied).toBe(result.rulesApplied);
    expect(preview.accounts.filter((a) => a.balance.snapshot)).toHaveLength(result.snapshotsWritten);
  });

  it('the review queue it predicted is the one the import leaves behind', async () => {
    // Same selection /transactions?payees=1 makes.
    const waiting = await prisma.transaction.count({
      where: { categoryId: null, flow: { not: 'TRANSFER' }, reimbursesId: null },
    });
    expect(waiting).toBe(3); // four rows, one caught by the netflix rule
  });

  it('previews a re-import of the same file as entirely duplicate', async () => {
    const preview = await previewImport(prisma, csvConnector(), new Date(0));
    expect(preview.newRows).toBe(0);
    expect(preview.duplicateRows).toBe(4);
    expect(preview.decisions).toEqual([]);
    expect(preview.merchants.unseen).toBe(0);
  });
});

describe('previewImport on the first look at a file', () => {
  let prisma: PrismaClient;
  beforeAll(async () => {
    prisma = await freshDb();
    await seedRule(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('counts the decisions the grouped review would ask for', async () => {
    const preview = await previewImport(prisma, csvConnector(), new Date(0));
    expect(preview.rulesApplied).toBe(1);
    expect(preview.categorized).toBe(1);
    expect(preview.reviewRows).toBe(3);
    // Two payees: the coffee shop twice, the paycheck once.
    expect(preview.decisions).toHaveLength(2);
    expect(preview.decisions.reduce((n, d) => n + d.count, 0)).toBe(3);
    expect(preview.decisions[0].count).toBe(2); // highest-leverage first
    expect(preview.decisionsJoiningExisting).toBe(0);
  });

  it('counts merchant strings, and which of them are new here', async () => {
    const preview = await previewImport(prisma, csvConnector(), new Date(0));
    expect(preview.merchants.distinct).toBe(3); // coffee, netflix, payroll
    expect(preview.merchants.unseen).toBe(3);
    expect(preview.merchants.unseenSingletons).toBe(2); // the coffee shop has two rows
  });

  it('reports a new account, with the balance and snapshot it would write', async () => {
    const preview = await previewImport(prisma, csvConnector(), new Date(0));
    expect(preview.accounts).toHaveLength(1);
    const [a] = preview.accounts;
    expect(a.disposition).toBe('CREATE');
    expect(a.ownedBy).toBeNull();
    expect(a.rows).toBe(4);
    expect(a.firstDate).toEqual(utc(2025, 2, 27));
    expect(a.lastDate).toEqual(utc(2025, 3, 14));
    expect(a.balance.writes).toBe(true);
    expect(a.balance.value).toBe(6252.68); // the newest posting's, not the file's last
    expect(a.balance.snapshot).toBe(true);
    expect(a.balance.movesBackward).toBe(false);
  });

  it('a capped import writes no balance and no snapshot', async () => {
    const preview = await previewImport(prisma, csvConnector(utc(2025, 3, 13)), new Date(0));
    const [a] = preview.accounts;
    expect(a.balance.writes).toBe(false);
    expect(a.balance.snapshot).toBe(false);
    expect(a.newRows).toBe(3); // the 03/14 row is behind the cap
  });
});

describe('previewImport on a backfill into a live account', () => {
  let prisma: PrismaClient;

  class Feed implements Connector {
    readonly type = 'SIMPLEFIN';
    listAccounts(): Promise<NormalizedAccount[]> {
      return Promise.resolve([
        {
          externalId: 'ext-checking',
          connectorType: 'SIMPLEFIN',
          institution: 'Test Bank',
          name: 'Primary Checking',
          type: 'DEPOSITORY',
          currency: 'USD',
          balance: 21053.65,
          balanceDate: utc(2026, 8, 7),
          isStale: false,
        },
      ]);
    }
    fetchTransactions(): Promise<NormalizedTransaction[]> {
      return Promise.resolve([]);
    }
  }

  beforeAll(async () => {
    prisma = await freshDb();
    await seedRule(prisma);
    await runSync(prisma, new Feed(), { since: new Date(0) });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // The lookup this leans on is sync.ts's own. A preview with its own copy
  // would announce CREATE here — for exactly the invocation the flag exists to
  // check — and the operator would cancel a backfill that was going to work.
  it('names the live account it would fill in, not a new one', async () => {
    const preview = await previewImport(prisma, csvConnector(utc(2025, 4, 1)), new Date(0));
    const [a] = preview.accounts;
    expect(a.disposition).toBe('ADOPT');
    expect(a.ownedBy).toBe('SIMPLEFIN');
    expect(a.name).toBe('Primary Checking'); // the import never renames it
    expect(await prisma.account.count()).toBe(1);
  });

  // The hazard `--until` quietly guards: uncapped, a backfill reports the
  // file's newest row as the CURRENT balance and runSync writes it over the
  // live one, dating it backward. Nothing refuses it, so the preview says it.
  it('warns when the balance write would move the balance backward', async () => {
    const preview = await previewImport(prisma, csvConnector(), new Date(0));
    const { balance } = preview.accounts[0];
    expect(balance.writes).toBe(true);
    expect(balance.value).toBe(6252.68);
    expect(balance.currentValue).toBe(21053.65);
    expect(balance.currentDate).toEqual(utc(2026, 8, 7));
    expect(balance.movesBackward).toBe(true);
  });

  it('and does not warn once the import is capped', async () => {
    const preview = await previewImport(prisma, csvConnector(utc(2025, 4, 1)), new Date(0));
    expect(preview.accounts[0].balance.movesBackward).toBe(false);
  });
});
