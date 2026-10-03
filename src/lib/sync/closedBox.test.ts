import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client';
import type { CashFlowTrendPayload, Connector, NormalizedAccount, NormalizedTransaction, SpendingByCategoryPayload } from '../../types/contracts';
import { INTERNAL_INVESTMENT_ACTIVITY } from '../insights/netWorth';
import { CLOSED_BOX_RULE_ID, crossesTheBoundary, flowByAmount, isClosedBox, whenCleared } from './closedBox';
import { previewImport } from './previewImport';
import { reapplyRules, releaseClosedBox, restoreTransactions } from './rulePack';
import { applyRules, type RuleData, type RuleTxn } from './rules';
import { runSync } from './sync';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

async function freshDb(prefix: string): Promise<{ dir: string; prisma: PrismaClient }> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const url = `file:${join(dir, 'test.db').replace(/\\/g, '/')}`;
  const conn = await new PrismaBetterSqlite3({ url }).connect();
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  const names = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    await conn.executeScript(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
  }
  await conn.dispose();
  return { dir, prisma: new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) }) };
}

describe('the closed box, as pure functions', () => {
  it('is an investment account and nothing else', () => {
    expect(isClosedBox('INVESTMENT')).toBe(true);
    for (const type of ['DEPOSITORY', 'CREDIT', 'LOAN', '', null, undefined]) {
      expect(isClosedBox(type), String(type)).toBe(false);
    }
  });

  it('asks the net-worth flows their own question, with their own pattern', () => {
    for (const inside of [
      'YOU BOUGHT TOTAL MARKET INDEX FUND (Cash)',
      'YOU SOLD TOTAL MARKET INDEX FUND (Cash)',
      'DIVIDEND RECEIVED TOTAL MARKET INDEX FUND',
      'REINVESTMENT TOTAL MARKET INDEX FUND',
      'PURCHASE INTO CORE ACCOUNT MONEY MARKET (Cash)',
      'REDEMPTION FROM CORE ACCOUNT MONEY MARKET (Cash)',
      'LONG-TERM CAP GAIN TOTAL MARKET INDEX FUND',
    ]) {
      expect(crossesTheBoundary(inside), inside).toBe(false);
      expect(INTERNAL_INVESTMENT_ACTIVITY.test(inside), inside).toBe(true);
    }
  });

  it('treats anything it does not recognise as a crossing, a verbless row included', () => {
    for (const crossing of [
      'ELECTRONIC FUNDS TRANSFER RECEIVED (Cash)',
      'TRANSFERRED FROM VS X00-000000-1',
      'BALANCED INDEX FUND',
      '',
    ]) {
      expect(crossesTheBoundary(crossing), crossing).toBe(true);
    }
  });

  it('gives a row the flow its own amount has', () => {
    expect(flowByAmount(12.5)).toBe('INFLOW');
    expect(flowByAmount(0)).toBe('INFLOW');
    expect(flowByAmount(-12.5)).toBe('OUTFLOW');
  });

  it('encloses a row at once when its category is cleared inside one', () => {
    expect(whenCleared('INVESTMENT')).toEqual({ categoryId: null, categorySource: 'RULE', flow: 'TRANSFER' });
  });

  it('and outside one, hands it back to the rules with its flow untouched', () => {
    for (const type of ['DEPOSITORY', 'CREDIT', 'LOAN', undefined]) {
      expect(whenCleared(type), String(type)).toEqual({ categoryId: null, categorySource: 'AGGREGATOR' });
    }
  });
});

describe('applyRules inside a closed box', () => {
  const rule = (partial: Partial<RuleData>): RuleData => ({
    id: 'r1', priority: 230, matchField: 'DESCRIPTION', matchOperator: 'CONTAINS',
    matchValue: 'dividend received', setCategoryId: 'income', setFlow: null, enabled: true, ...partial,
  });
  const txn = (partial: Partial<RuleTxn>): RuleTxn => ({
    id: 't1', amount: 12.34, description: 'DIVIDEND RECEIVED TOTAL MARKET INDEX FUND',
    normalizedMerchant: 'dividend', accountName: 'Individual', accountType: 'INVESTMENT',
    categorySource: 'AGGREGATOR', ...partial,
  });
  const boxed = { txnId: 't1', ruleId: CLOSED_BOX_RULE_ID, categoryId: null, flow: 'TRANSFER' };

  it('makes the row a transfer before any rule is asked', () => {
    expect(applyRules([rule({})], [txn({})])).toEqual([boxed]);
  });

  it('needs no rule at all', () => {
    expect(applyRules([], [txn({})])).toEqual([boxed]);
  });

  it('outranks a rule the operator wrote, which matched by wording', () => {
    expect(applyRules([rule({ priority: 50 })], [txn({})])).toEqual([boxed]);
  });

  it('leaves a row a person categorized exactly where they put it', () => {
    expect(applyRules([rule({})], [txn({ categorySource: 'MANUAL' })])).toEqual([]);
  });

  it('is not applied outside one: the same wording in a bank account is still income', () => {
    expect(applyRules([rule({})], [txn({ accountType: 'DEPOSITORY' })])).toEqual([
      { txnId: 't1', ruleId: 'r1', categoryId: 'income', flow: null },
    ]);
    expect(applyRules([rule({})], [txn({ accountType: undefined })])[0]?.ruleId).toBe('r1');
  });
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

const account = (externalId: string, name: string, type: NormalizedAccount['type'], balance: number): NormalizedAccount => ({
  externalId, connectorType: 'SIMPLEFIN', institution: 'Test Bank', name, type, currency: 'USD',
  balance, balanceDate: utc(2026, 7, 28), isStale: false,
});
const ACCOUNTS = [
  account('ext-checking', 'Checking', 'DEPOSITORY', 4000),
  account('ext-brokerage', 'Individual', 'INVESTMENT', 52_000),
  account('ext-401k', 'Workplace Savings Plan', 'INVESTMENT', 81_000),
];
const row = (acct: string, externalId: string, date: Date, amount: number, description: string, merchant = description.toLowerCase()): NormalizedTransaction => ({
  accountExternalId: acct, externalId, date, amount, description, normalizedMerchant: merchant,
  flow: amount >= 0 ? 'INFLOW' : 'OUTFLOW', source: 'SIMPLEFIN',
});
const SINCE = utc(2026, 6, 1);

describe('the closed box through the whole pipeline', () => {
  let dir: string;
  let prisma: PrismaClient;
  let incomeId: string;
  let hobbyId: string;

  const stored = async (externalId: string) => {
    const t = await prisma.transaction.findFirstOrThrow({ where: { externalId } });
    return { flow: t.flow, categoryId: t.categoryId, source: t.categorySource, paired: t.transferPairId !== null };
  };
  const july = async <T>(type: string): Promise<T> =>
    (await prisma.insight.findFirstOrThrow({ where: { type, period: '2026-07' } })).payload as unknown as T;
  const TRANSFER = { flow: 'TRANSFER', categoryId: null, source: 'RULE', paired: false };

  const firstImport = [
    row('ext-checking', 't-salary', utc(2026, 7, 1), 3000, 'NORTHWIND LABS PAYROLL', 'northwind labs'),
    row('ext-checking', 't-groceries', utc(2026, 7, 8), -120, 'CORNER GROCER', 'corner grocer'),
    row('ext-brokerage', 't-sold', utc(2026, 7, 9), 900, 'YOU SOLD ACME INDEX FUND (Cash)', 'acme index fund'),
    row('ext-brokerage', 't-bought', utc(2026, 7, 9), -900, 'YOU BOUGHT ACME BOND FUND (Cash)', 'acme bond fund'),
    row('ext-brokerage', 't-dividend', utc(2026, 7, 10), 12.34, 'DIVIDEND RECEIVED ACME INDEX FUND (Cash)', 'acme index fund'),
    row('ext-brokerage', 't-foreign-tax', utc(2026, 7, 10), -1.5, 'FOREIGN TAX PAID ACME INDEX FUND (Cash)', 'acme index fund'),
    row('ext-brokerage', 't-fee', utc(2026, 7, 11), -3, 'FEE CHARGED ACME INDEX FUND (Cash)', 'acme index fund'),
    // A workplace plan names the fund and nothing else: contributions and loan
    // repayments arrive with no verb for any wording rule to find.
    row('ext-401k', 't-contribution', utc(2026, 7, 15), 150, 'BALANCED INDEX FUND', 'payroll contribution'),
    row('ext-401k', 't-loan-repayment', utc(2026, 7, 15), 60.25, 'BALANCED INDEX FUND', 'loan repayment'),
    // The brokerage's side of a deposit, arriving a sync BEFORE the bank's.
    row('ext-brokerage', 't-deposit-in', utc(2026, 7, 14), 500, 'ELECTRONIC FUNDS TRANSFER RECEIVED (Cash)', 'electronic funds transfer'),
    // A sale and an unrelated bill of the same amount, a day apart.
    row('ext-brokerage', 't-sold-640', utc(2026, 7, 20), 640, 'YOU SOLD ACME BOND FUND (Cash)', 'acme bond fund'),
    row('ext-checking', 't-water-bill', utc(2026, 7, 21), -640, 'CITY WATER UTILITY', 'city water utility'),
  ];
  const secondImport = [
    ...firstImport,
    row('ext-checking', 't-deposit-out', utc(2026, 7, 15), -500, 'NORTHWIND BROKERAGE MONEYLINE', 'northwind brokerage'),
  ];

  beforeAll(async () => {
    ({ dir, prisma } = await freshDb('ducat-closed-box-test-'));
    incomeId = (await prisma.category.create({ data: { name: 'Income', isIncome: true } })).id;
    hobbyId = (await prisma.category.create({ data: { name: 'Hobbies' } })).id;
    await prisma.rule.createMany({
      data: [
        // The pack's dividend rule, which used to make this row income.
        { priority: 230, matchField: 'DESCRIPTION', matchOperator: 'REGEX', matchValue: '\\bdividends?\\s+received\\b', setCategoryId: incomeId, enabled: true },
        // A rule the operator wrote, matching the brokerage's rows by merchant.
        { priority: 50, matchField: 'MERCHANT', matchOperator: 'CONTAINS', matchValue: 'acme index fund', setCategoryId: hobbyId, enabled: true },
      ],
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('previews exactly the applications the import then makes', async () => {
    const preview = await previewImport(prisma, new FakeConnector(ACCOUNTS, firstImport), SINCE);
    const result = await runSync(prisma, new FakeConnector(ACCOUNTS, firstImport), { since: SINCE });
    expect(preview.rulesApplied).toBe(result.rulesApplied);
    // Every row inside the two investment accounts, and none outside them.
    expect(result.rulesApplied).toBe(9);
    expect(preview.reviewRows).toBe(3); // the salary, the groceries, the water bill
  });

  it('marks everything inside an investment account a transfer, whatever it is called', async () => {
    for (const id of ['t-sold', 't-bought', 't-dividend', 't-foreign-tax', 't-fee', 't-sold-640']) {
      expect(await stored(id), id).toEqual(TRANSFER);
    }
  });

  it('does it for rows with no verb, where no wording rule could', async () => {
    expect(await stored('t-contribution')).toEqual(TRANSFER);
    expect(await stored('t-loan-repayment')).toEqual(TRANSFER);
  });

  it('leaves the bank accounts exactly as they were', async () => {
    expect(await stored('t-salary')).toEqual({ flow: 'INFLOW', categoryId: null, source: 'AGGREGATOR', paired: false });
    expect(await stored('t-groceries')).toEqual({ flow: 'OUTFLOW', categoryId: null, source: 'AGGREGATOR', paired: false });
  });

  it('counts as income and spending only what reached a bank account', async () => {
    const flow = await july<CashFlowTrendPayload>('CASH_FLOW_TREND');
    expect(flow.income).toBe(3000);
    expect(flow.spending).toBe(760); // groceries and the water bill
    const spending = await july<SpendingByCategoryPayload>('SPENDING_BY_CATEGORY');
    expect(spending.totalSpending).toBe(760);
  });

  it('does not pair a sale with an unrelated bill of the same amount', async () => {
    expect(await stored('t-water-bill')).toEqual({ flow: 'OUTFLOW', categoryId: null, source: 'AGGREGATOR', paired: false });
    expect((await stored('t-sold-640')).paired).toBe(false);
  });

  it('still pairs a deposit whose brokerage side arrived a sync before the bank side', async () => {
    expect(await stored('t-deposit-in')).toEqual(TRANSFER); // enclosed, and waiting

    const result = await runSync(prisma, new FakeConnector(ACCOUNTS, secondImport), { since: SINCE });
    expect(result.transactionsImported).toBe(1);
    expect(result.transfersLinked).toBe(1);

    const out = await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-deposit-out' } });
    const inn = await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-deposit-in' } });
    expect(out.flow).toBe('TRANSFER');
    expect(out.transferPairId).toBe(inn.id);
    expect(inn.transferPairId).toBe(out.id);
    // So the deposit is not spending.
    expect((await july<CashFlowTrendPayload>('CASH_FLOW_TREND')).spending).toBe(760);
  });

  it('is idempotent: a second pass moves nothing', async () => {
    expect(await reapplyRules(prisma)).toEqual({ changed: 0, restore: [], enclosed: 0 });
  });

  it('reaches rows that were stored before it existed, and counts them apart', async () => {
    const brokerage = await prisma.account.findFirstOrThrow({ where: { externalId: 'ext-brokerage' } });
    await prisma.transaction.createMany({
      data: [
        { externalId: 'old-sold', amount: 410, description: 'YOU SOLD ACME INDEX FUND (Cash)', flow: 'INFLOW' as const, categoryId: null, categorySource: 'AGGREGATOR' as const },
        { externalId: 'old-dividend', amount: 8.2, description: 'DIVIDEND RECEIVED ACME INDEX FUND (Cash)', flow: 'INFLOW' as const, categoryId: incomeId, categorySource: 'RULE' as const },
        { externalId: 'old-manual', amount: 9.9, description: 'DIVIDEND RECEIVED ACME BOND FUND (Cash)', flow: 'INFLOW' as const, categoryId: incomeId, categorySource: 'MANUAL' as const },
      ].map((t) => ({ ...t, accountId: brokerage.id, date: utc(2026, 6, 12), normalizedMerchant: 'acme', source: 'SIMPLEFIN' as const })),
    });
    const water = await prisma.category.create({ data: { name: 'Utilities' } });
    await prisma.rule.create({
      data: { priority: 50, matchField: 'MERCHANT', matchOperator: 'CONTAINS', matchValue: 'city water utility', setCategoryId: water.id, enabled: true },
    });

    const { changed, restore, enclosed } = await reapplyRules(prisma);

    expect(enclosed).toBe(2);
    expect(await stored('old-sold')).toEqual(TRANSFER);
    expect(await stored('old-dividend')).toEqual(TRANSFER); // its Income category is gone with it
    // A person's decision stands, inside the box as everywhere else.
    expect(await stored('old-manual')).toEqual({ flow: 'INFLOW', categoryId: incomeId, source: 'MANUAL', paired: false });

    // The rule decision is what the snapshot holds, and ALL it holds.
    expect(changed).toBe(1);
    expect(restore).toEqual([{ id: expect.any(String), categoryId: null, categorySource: 'AGGREGATOR', flow: 'OUTFLOW' }]);
    expect((await stored('t-water-bill')).categoryId).toBe(water.id);

    // So undoing the rule does not hand the brokerage's rows back to income.
    await restoreTransactions(prisma, restore);
    expect((await stored('t-water-bill')).categoryId).toBeNull();
    expect(await stored('old-sold')).toEqual(TRANSFER);
    expect(await stored('old-dividend')).toEqual(TRANSFER);
  });

  it('lets go of an account that stops being an investment account', async () => {
    const plan = await prisma.account.findFirstOrThrow({ where: { externalId: 'ext-401k' } });
    await prisma.account.update({ where: { id: plan.id }, data: { type: 'DEPOSITORY' } });

    expect(await releaseClosedBox(prisma, plan.id)).toBe(2);
    await reapplyRules(prisma);

    const free = { flow: 'INFLOW', categoryId: null, source: 'AGGREGATOR', paired: false };
    expect(await stored('t-contribution')).toEqual(free);
    expect(await stored('t-loan-repayment')).toEqual(free);
    // The account that is still one is untouched.
    expect(await stored('t-sold')).toEqual(TRANSFER);
  });

  it('on release, keeps a pair linked, a manual row manual, and lets rules decide the rest', async () => {
    const brokerage = await prisma.account.findFirstOrThrow({ where: { externalId: 'ext-brokerage' } });
    await prisma.account.update({ where: { id: brokerage.id }, data: { type: 'DEPOSITORY' } });

    await releaseClosedBox(prisma, brokerage.id);
    await reapplyRules(prisma);

    const pairedBefore = await stored('t-deposit-in');
    expect(pairedBefore.flow).toBe('TRANSFER');
    expect(pairedBefore.paired).toBe(true);
    expect((await stored('old-manual')).source).toBe('MANUAL');
    // Outside the box the wording rules apply again: the operator's merchant
    // rule outranks the pack's dividend rule, as it always did.
    expect(await stored('t-dividend')).toEqual({ flow: 'INFLOW', categoryId: hobbyId, source: 'RULE', paired: false });
    expect(await stored('t-bought')).toEqual({ flow: 'OUTFLOW', categoryId: null, source: 'AGGREGATOR', paired: false });

    // And back in, it is a box again.
    await prisma.account.update({ where: { id: brokerage.id }, data: { type: 'INVESTMENT' } });
    await reapplyRules(prisma);
    expect(await stored('t-dividend')).toEqual(TRANSFER);
    expect(await stored('t-bought')).toEqual(TRANSFER);
  });
});

describe('the closed box on a database with no rules', () => {
  let dir: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ({ dir, prisma } = await freshDb('ducat-closed-box-norules-test-'));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies on import', async () => {
    const result = await runSync(
      prisma,
      new FakeConnector(ACCOUNTS, [
        row('ext-checking', 't-salary', utc(2026, 7, 1), 3000, 'NORTHWIND LABS PAYROLL', 'northwind labs'),
        row('ext-brokerage', 't-sold', utc(2026, 7, 9), 900, 'YOU SOLD ACME INDEX FUND (Cash)', 'acme index fund'),
      ]),
      { since: SINCE },
    );
    expect(result.rulesApplied).toBe(1);
    expect((await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-sold' } })).flow).toBe('TRANSFER');
    expect((await prisma.transaction.findFirstOrThrow({ where: { externalId: 't-salary' } })).flow).toBe('INFLOW');
  });

  it('and on reapply, which used to return early when there were no rules', async () => {
    const brokerage = await prisma.account.findFirstOrThrow({ where: { externalId: 'ext-brokerage' } });
    await prisma.transaction.create({
      data: {
        accountId: brokerage.id, externalId: 'old-bought', date: utc(2026, 6, 3), amount: -300,
        description: 'YOU BOUGHT ACME INDEX FUND (Cash)', normalizedMerchant: 'acme index fund',
        flow: 'OUTFLOW', categorySource: 'AGGREGATOR', source: 'SIMPLEFIN',
      },
    });
    expect(await reapplyRules(prisma)).toEqual({ changed: 0, restore: [], enclosed: 1 });
    expect((await prisma.transaction.findFirstOrThrow({ where: { externalId: 'old-bought' } })).flow).toBe('TRANSFER');
  });
});
