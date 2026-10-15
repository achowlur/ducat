import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client';
import { normalizeMerchant } from '../connectors/normalize';
import { settleLatePostings, type ParsedStatement } from '../connectors/pdf/statement';
import { previewImport } from './previewImport';
import {
  batchIdFor,
  connectorFor,
  planStatementImport,
  writeStatementImport,
  type StatementFile,
} from './statementImport';

const utc = (m: number, d: number) => new Date(Date.UTC(2025, m - 1, d, 12));

// An INVENTED card statement, in the app's signs (the balance owed is
// negative). Stored history begins 03/05, inside its period.
const statement = (overrides: Partial<ParsedStatement> = {}): ParsedStatement => ({
  layout: 'test',
  institution: 'Example Bank',
  accountType: 'CREDIT',
  accountLast4: '0001',
  periodStart: utc(2, 10),
  periodEnd: utc(3, 13),
  openingBalance: -1000,
  closingBalance: -709,
  rows: [
    { date: utc(2, 18), description: 'CORNER CAFE', amount: -20 },
    { date: utc(2, 25), description: 'EXAMPLE GROCER', amount: -150 },
    { date: utc(3, 4), description: 'PAYMENT THANK YOU', amount: 500 },
    { date: utc(3, 8), description: 'EXAMPLE BOOKSHOP', amount: -30 },
    { date: utc(3, 10), description: 'EXAMPLE COFFEE', amount: -4.5 },
    { date: utc(3, 12), description: 'EXAMPLE COFFEE', amount: -4.5 },
  ],
  checks: [],
  ...overrides,
});

const file = (name: string, sha: string, s = statement()): StatementFile => ({
  fileName: name,
  fileSha256: sha.padEnd(64, '0'),
  statement: s,
});

let dir: string;
let prisma: PrismaClient;
let accountId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ducat-statement-test-'));
  const url = `file:${join(dir, 'test.db').replace(/\\/g, '/')}`;
  const factory = new PrismaBetterSqlite3({ url });
  const conn = await factory.connect();
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  for (const name of readdirSync(migrationsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    await conn.executeScript(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
  }
  await conn.dispose();
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

  const account = await prisma.account.create({
    data: {
      externalId: 'ext-card',
      connectorType: 'SIMPLEFIN',
      institution: 'Example Bank',
      name: 'Example Card (0001)',
      type: 'CREDIT',
      currency: 'USD',
      balance: -700,
      balanceDate: utc(3, 20),
      isStale: false,
    },
  });
  accountId = account.id;
  const feed = (externalId: string, date: Date, amount: number, description: string) => ({
    accountId,
    externalId,
    date,
    amount,
    description,
    normalizedMerchant: description.toLowerCase(),
    flow: amount >= 0 ? ('INFLOW' as const) : ('OUTFLOW' as const),
    categorySource: 'AGGREGATOR' as const,
    source: 'SIMPLEFIN' as const,
  });
  await prisma.transaction.createMany({
    data: [
      feed('feed-pay', utc(3, 6), 500, 'PAYMENT RECEIVED'),
      feed('feed-other', utc(3, 9), -60, 'EXAMPLE FUEL'),
      feed('feed-coffee', utc(3, 11), -4.5, 'EXAMPLE COFFEE'),
      feed('feed-first', utc(3, 5), -1, 'EXAMPLE PARKING'),
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

const verdictOf = async (files: StatementFile[]) => {
  const plan = await planStatementImport(prisma, files, { windowDays: 4 });
  return {
    plan,
    kinds: plan.statements.flatMap((p) => p.rows.map((r) => `${r.row.description} ${r.verdict.kind}`)),
  };
};

describe('planStatementImport', () => {
  it('sorts every row into older history, already stored, a gap, or ambiguous', async () => {
    const { kinds } = await verdictOf([file('a.pdf', 'aa')]);
    expect(kinds).toEqual([
      'CORNER CAFE NEW',
      'EXAMPLE GROCER NEW',
      'PAYMENT THANK YOU MATCHED',
      'EXAMPLE BOOKSHOP GAP',
      'EXAMPLE COFFEE MATCHED',
      'EXAMPLE COFFEE AMBIGUOUS',
    ]);
  });

  it('files the statement under the account its last four digits name', async () => {
    const { plan } = await verdictOf([file('a.pdf', 'aa')]);
    expect(plan.statements.map((p) => p.account.id)).toEqual([accountId]);
    expect(plan.statements[0].batchId).toBe(batchIdFor('aa'.padEnd(64, '0'), '0001'));
  });

  it('lists stored rows inside the period that no statement row explains', async () => {
    const { plan } = await verdictOf([file('a.pdf', 'aa')]);
    expect(plan.storedOnly.get(accountId)?.map((r) => r.description)).toEqual(['EXAMPLE PARKING', 'EXAMPLE FUEL']);
  });

  it('plans one closing-balance snapshot per statement', async () => {
    const { plan } = await verdictOf([file('a.pdf', 'aa')]);
    expect(plan.snapshots).toEqual([{ accountId, date: utc(3, 13), balance: -709 }]);
  });

  it('skips a statement for an account it cannot name, saying why', async () => {
    const { plan } = await verdictOf([file('b.pdf', 'bb', statement({ accountLast4: '9999' }))]);
    expect(plan.statements).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/ending in 9999/);
  });

  it('skips the same file, and the same statement in another file, within one run', async () => {
    const { plan } = await verdictOf([file('a.pdf', 'aa'), file('a copy.pdf', 'aa'), file('redownload.pdf', 'cc')]);
    expect(plan.statements.map((p) => p.file.fileName)).toEqual(['a.pdf']);
    expect(plan.skipped.map((s) => s.fileName)).toEqual(['a copy.pdf', 'redownload.pdf']);
  });

  it('skips a statement overlapping another, but not one sharing only its boundary day', async () => {
    const quarter = statement({ periodStart: utc(1, 1), periodEnd: utc(3, 13), rows: [] });
    const next = statement({ periodStart: utc(3, 13), periodEnd: utc(4, 12), rows: [] });
    const { plan } = await verdictOf([file('a.pdf', 'aa'), file('quarter.pdf', 'ee', quarter), file('next.pdf', 'ff', next)]);
    expect(plan.statements.map((p) => p.file.fileName)).toEqual(['a.pdf', 'next.pdf']);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'this 2025-01-01 to 2025-03-13 statement overlaps the 2025-02-10 to 2025-03-13 one already in this run, as a.pdf',
    ]);
  });

  // One --external-id cannot route two accounts; forcing both into it would mix them.
  it('refuses --external-id for a file holding several accounts', async () => {
    const report = [file('report.pdf', 'dd'), file('report.pdf', 'dd', statement({ accountLast4: '0002' }))];
    const plan = await planStatementImport(prisma, report, { windowDays: 4, externalId: 'ext-card' });
    expect(plan.statements).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      'it holds 2 accounts and --external-id names one, so the account ending in 0001 is left out (run it without --external-id)',
      'it holds 2 accounts and --external-id names one, so the account ending in 0002 is left out (run it without --external-id)',
    ]);
  });
});

describe('an investment statement', () => {
  let brokerageId: string;
  const plan = async () => {
    const report = statement({
      institution: 'Example Brokerage',
      accountType: 'INVESTMENT',
      accountLast4: '0003',
      openingBalance: 5123.89,
      closingBalance: 5123.89,
      rows: [{ date: utc(2, 24), description: 'EFT FUNDS RECEIVED', amount: 397.52 }],
    });
    return verdictOf([file('brokerage.pdf', 'b1', report)]);
  };

  beforeAll(async () => {
    const brokerage = await prisma.account.create({
      data: {
        externalId: 'ext-brokerage',
        connectorType: 'SIMPLEFIN',
        institution: 'Example Brokerage',
        name: 'Brokerage (0003)',
        type: 'INVESTMENT',
        currency: 'USD',
        balance: 5123.89,
        balanceDate: utc(3, 20),
        isStale: false,
      },
    });
    const row = (externalId: string, date: Date, amount: number, description: string) => ({
      accountId: brokerage.id,
      externalId,
      date,
      amount,
      description,
      normalizedMerchant: description.toLowerCase(),
      flow: 'TRANSFER' as const,
      categorySource: 'AGGREGATOR' as const,
      source: 'SIMPLEFIN' as const,
    });
    await prisma.transaction.createMany({
      data: [
        row('feed-dividend', utc(2, 20), 12.47, 'DIVIDEND RECEIVED EXAMPLE INDEX FUND'),
        row('feed-buy', utc(2, 21), -318.06, 'YOU BOUGHT EXAMPLE INDEX FUND'),
        row('feed-out', utc(3, 1), -246.91, 'TRANSFERRED TO EXAMPLE BANK'),
        // The feed signs a brokerage deposit negative; the statement prints it positive.
        row('feed-in', utc(2, 25), -397.52, 'EFT FUNDS RECEIVED'),
      ],
    });
    brokerageId = brokerage.id;
  });

  it('matches a stored row of the same amount whichever sign its source gave it', async () => {
    const { kinds } = await plan();
    expect(kinds).toEqual(['EFT FUNDS RECEIVED MATCHED']);
  });

  // It lists only money crossing the account, so trades and dividends are never on it.
  it('lists no trade or dividend among the stored rows it does not explain', async () => {
    const { plan: planned } = await plan();
    expect(planned.storedOnly.get(brokerageId)?.map((r) => r.description)).toEqual(['TRANSFERRED TO EXAMPLE BANK']);
  });
});

describe('the dry run and the write agree', () => {
  it('previews exactly the rows the write then adds, and writes nothing itself', async () => {
    const plan = await planStatementImport(prisma, [file('a.pdf', 'aa')], { windowDays: 4 });
    const before = await prisma.transaction.count();
    const preview = await previewImport(prisma, connectorFor(plan), new Date(0));
    expect(await prisma.transaction.count()).toBe(before);

    const result = await writeStatementImport(prisma, plan);
    expect(preview.newRows).toBe(3);
    expect(result.sync.transactionsImported).toBe(preview.newRows);
    expect(await prisma.transaction.count()).toBe(before + 3);
  });

  it('marks every added row with its source and statement, and records the statement', async () => {
    const rows = await prisma.transaction.findMany({ where: { source: 'PDF' }, orderBy: { date: 'asc' } });
    expect(rows.map((r) => r.description)).toEqual(['CORNER CAFE', 'EXAMPLE GROCER', 'EXAMPLE BOOKSHOP']);
    const batchId = batchIdFor('aa'.padEnd(64, '0'), '0001');
    expect(new Set(rows.map((r) => r.importBatchId))).toEqual(new Set([batchId]));
    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect([batch.fileName, batch.rowsAdded, batch.accountId]).toEqual(['a.pdf', 3, accountId]);
  });

  it('writes the closing balance as a snapshot and leaves the current balance alone', async () => {
    const snapshot = await prisma.balanceSnapshot.findFirstOrThrow({ where: { accountId, date: utc(3, 13) } });
    expect(Number(snapshot.balance)).toBe(-709);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect([Number(account.balance), account.connectorType]).toEqual([-700, 'SIMPLEFIN']);
  });

  it('skips the file on a later run, and the same statement under another name', async () => {
    const plan = await planStatementImport(prisma, [file('a.pdf', 'aa'), file('renamed.pdf', 'dd')], { windowDays: 4 });
    expect(plan.statements).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      expect.stringMatching(/^already imported on \d{4}-\d{2}-\d{2}, as a\.pdf$/),
      'this 2025-02-10 to 2025-03-13 statement is already imported, from a.pdf',
    ]);
  });
});

// A card lists a late-posted charge under the merchant's date, months before
// the statement it appears on; the feed stored it when it POSTED.
describe('an account the statements cover and Ducat never had', () => {
  // A closed brokerage account: emptied by a transfer out in its last statement.
  const closing = statement({
    accountType: 'INVESTMENT',
    accountLast4: '0007',
    periodStart: utc(1, 1),
    periodEnd: utc(1, 31),
    openingBalance: 634.18,
    closingBalance: 0,
    rows: [{ date: utc(1, 10), description: 'TRANSFERRED TO EXAMPLE BANK', amount: -634.18 }],
  });
  const create = { last4: '0007', name: 'Closed brokerage' };

  it('is skipped, saying how to add it, unless asked for', async () => {
    const { plan } = await verdictOf([file('closed.pdf', 'c7', closing)]);
    expect(plan.statements).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/--create-account=0007 to add it/);
  });

  it('is planned under its own name and digits, its balance its last close', async () => {
    const plan = await planStatementImport(prisma, [file('closed.pdf', 'c7', closing)], { windowDays: 4, createAccount: create });
    expect(plan.newAccounts.map((n) => [n.account.name, n.account.institution, n.account.type, n.balance, n.balanceDate])).toEqual([
      ['Closed brokerage (0007)', 'Example Bank', 'INVESTMENT', 0, utc(1, 31)],
    ]);
    expect(plan.statements.map((p) => p.rows.map((r) => r.verdict.kind))).toEqual([['NEW']]);
  });

  it('is never created when an account carries those digits', async () => {
    await expect(planStatementImport(prisma, [file('a.pdf', 'aa')], { windowDays: 4, createAccount: { last4: '0001' } })).rejects.toThrow(
      'No statement in this run is for a missing account ending in 0001',
    );
  });

  it('is created by the write, then matched like any account on a re-run', async () => {
    const plan = await planStatementImport(prisma, [file('closed.pdf', 'c7', closing)], { windowDays: 4, createAccount: create });
    await writeStatementImport(prisma, plan);
    const made = await prisma.account.findFirstOrThrow({ where: { name: 'Closed brokerage (0007)' } });
    expect([made.connectorType, made.isStale, Number(made.balance), made.balanceDate]).toEqual(['PDF', false, 0, utc(1, 31)]);
    expect(await prisma.transaction.count({ where: { accountId: made.id } })).toBe(1);
    expect(await prisma.balanceSnapshot.count({ where: { accountId: made.id } })).toBe(1);
    expect(await prisma.importBatch.count({ where: { accountId: made.id } })).toBe(1);

    const again = await planStatementImport(prisma, [file('closed.pdf', 'c7', closing)], { windowDays: 4 });
    expect(again.skipped.map((k) => k.reason)).toEqual([expect.stringMatching(/^already imported on /)]);
  });
});

describe('a late-posted row', () => {
  let cardId: string;

  beforeAll(async () => {
    const card = await prisma.account.create({
      data: {
        externalId: 'ext-card-2',
        connectorType: 'SIMPLEFIN',
        institution: 'Example Bank',
        name: 'Example Card (0002)',
        type: 'CREDIT',
        currency: 'USD',
        balance: 0,
        balanceDate: utc(9, 20),
        isStale: false,
      },
    });
    cardId = card.id;
    const feed = (externalId: string, date: Date, amount: number, description: string) => ({
      accountId: cardId,
      externalId,
      date,
      amount,
      description,
      normalizedMerchant: description.toLowerCase(),
      flow: 'OUTFLOW' as const,
      categorySource: 'AGGREGATOR' as const,
      source: 'SIMPLEFIN' as const,
    });
    await prisma.transaction.createMany({
      data: [feed('feed-late', utc(8, 20), -12, 'EXAMPLE DINER'), feed('feed-first', utc(1, 5), -1, 'EXAMPLE PARKING')],
    });
  });

  const late = () =>
    settleLatePostings(
      statement({
        accountLast4: '0002',
        periodStart: utc(8, 10),
        periodEnd: utc(9, 9),
        openingBalance: 0,
        closingBalance: -42,
        rows: [
          { date: utc(3, 11), description: 'EXAMPLE DINER', amount: -12 },
          { date: utc(3, 11), description: 'EXAMPLE DINER', amount: -30 },
        ],
      }),
    );

  it('is dated on the opening day, and still matches what the feed stored when it posted', async () => {
    const plan = await planStatementImport(prisma, [file('late.pdf', 'ee', late())], { windowDays: 4 });
    expect(plan.statements[0].rows.map((r) => [r.row.date, r.verdict.kind])).toEqual([
      [utc(8, 10), 'MATCHED'],
      [utc(8, 10), 'GAP'],
    ]);
  });

  it('is stored with the merchant date in its description and its merchant as printed', async () => {
    await writeStatementImport(prisma, await planStatementImport(prisma, [file('late.pdf', 'ee', late())], { windowDays: 4 }));
    const row = await prisma.transaction.findFirstOrThrow({ where: { accountId: cardId, source: 'PDF' } });
    expect([row.date, row.description, row.normalizedMerchant, Number(row.amount)]).toEqual([
      utc(8, 10),
      'EXAMPLE DINER (transaction date 03/11/2025)',
      normalizeMerchant('EXAMPLE DINER'),
      -30,
    ]);
  });
});
