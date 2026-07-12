import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

/**
 * Seeds deterministic fixture data for developing the insights engine:
 * ~8.5 months (Nov 2025 – Jul 2026) across five accounts, with transfer
 * pairs, recurring subscriptions (one with a price increase), and two
 * planted anomalies. Wipes existing data first. Amounts vary via a seeded
 * LCG so re-running produces byte-identical data.
 */

let lcgState = 42;
function rand(): number {
  lcgState = (lcgState * 1_103_515_245 + 12_345) % 2_147_483_648;
  return lcgState / 2_147_483_648;
}
function randBetween(min: number, max: number): number {
  return Math.round((min + rand() * (max - min)) * 100) / 100;
}

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

interface TxnSpec {
  id: string;
  accountKey: string;
  date: Date;
  amount: number;
  description: string;
  merchant: string;
  flow: 'INFLOW' | 'OUTFLOW' | 'TRANSFER';
  category: string | null;
  pairWith?: string; // id of the counterpart TRANSFER
}

async function main(): Promise<void> {
  await prisma.insight.deleteMany();
  await prisma.balanceSnapshot.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.rule.deleteMany();
  await prisma.category.deleteMany();
  await prisma.account.deleteMany();
  await prisma.syncLog.deleteMany();
  await prisma.trackedSubscription.deleteMany();

  const categoryNames = [
    'Salary', 'Interest', 'Rent', 'Groceries', 'Dining', 'Utilities',
    'Subscriptions', 'Transport', 'Entertainment', 'Shopping',
  ];
  const categories = new Map<string, string>();
  for (const name of categoryNames) {
    const row = await prisma.category.create({ data: { name } });
    categories.set(name, row.id);
  }

  const accountDefs = [
    { key: 'checking', name: 'Primary Checking', institution: 'First National', type: 'DEPOSITORY' as const, opening: 3000 },
    { key: 'savings', name: 'High-Yield Savings', institution: 'First National', type: 'DEPOSITORY' as const, opening: 10000 },
    { key: 'credit', name: 'Rewards Visa', institution: 'Capital Bank', type: 'CREDIT' as const, opening: -400 },
    { key: 'brokerage', name: 'Brokerage', institution: 'Vanguard', type: 'INVESTMENT' as const, opening: 15000 },
    { key: 'loan', name: 'Auto Loan', institution: 'Capital Bank', type: 'LOAN' as const, opening: -12000 },
  ];

  // Months: Nov 2025 (2025, 11) through Jul 2026 (2026, 7).
  const months: [number, number][] = [
    [2025, 11], [2025, 12], [2026, 1], [2026, 2], [2026, 3], [2026, 4], [2026, 5], [2026, 6], [2026, 7],
  ];
  const today = utc(2026, 7, 12);

  const txns: TxnSpec[] = [];
  let n = 0;
  const nextId = () => `txn_${String(++n).padStart(4, '0')}`;
  const add = (spec: Omit<TxnSpec, 'id'>): string => {
    const id = nextId();
    txns.push({ id, ...spec });
    return id;
  };
  const addPair = (
    from: string, to: string, date: Date, amount: number, description: string, merchant: string,
  ): void => {
    const a = add({ accountKey: from, date, amount: -amount, description, merchant, flow: 'TRANSFER', category: null });
    const b = add({ accountKey: to, date, amount, description, merchant, flow: 'TRANSFER', category: null, pairWith: a });
    txns[txns.length - 2].pairWith = b;
  };

  for (const [y, m] of months) {
    const inMonth = (d: number) => utc(y, m, d);
    const skip = (d: number) => inMonth(d).getTime() > today.getTime();

    // Checking: income and fixed bills
    if (!skip(1)) add({ accountKey: 'checking', date: inMonth(1), amount: 5400, description: 'ACME CORP PAYROLL', merchant: 'acme corp', flow: 'INFLOW', category: 'Salary' });
    if (!skip(2)) add({ accountKey: 'checking', date: inMonth(2), amount: -1800, description: 'OAKWOOD APTS RENT', merchant: 'oakwood apartments', flow: 'OUTFLOW', category: 'Rent' });
    if (!skip(5)) add({ accountKey: 'checking', date: inMonth(5), amount: -11.99, description: 'SPOTIFY USA', merchant: 'spotify', flow: 'OUTFLOW', category: 'Subscriptions' });
    if (!skip(10)) {
      const netflixPrice = y === 2026 && m >= 6 ? 18.99 : 15.99; // price hike in June
      add({ accountKey: 'checking', date: inMonth(10), amount: -netflixPrice, description: 'NETFLIX.COM', merchant: 'netflix', flow: 'OUTFLOW', category: 'Subscriptions' });
    }
    if (!skip(15)) add({ accountKey: 'checking', date: inMonth(15), amount: -45, description: 'PLANET FITNESS', merchant: 'planet fitness', flow: 'OUTFLOW', category: 'Subscriptions' });
    if (!skip(18)) add({ accountKey: 'checking', date: inMonth(18), amount: -randBetween(105, 140), description: 'CITY POWER & WATER', merchant: 'city power & water', flow: 'OUTFLOW', category: 'Utilities' });
    if (!skip(20)) add({ accountKey: 'checking', date: inMonth(20), amount: -60, description: 'COMCAST INTERNET', merchant: 'comcast', flow: 'OUTFLOW', category: 'Utilities' });

    // Savings interest
    if (!skip(28)) add({ accountKey: 'savings', date: inMonth(28), amount: randBetween(8, 14), description: 'INTEREST PAYMENT', merchant: 'first national', flow: 'INFLOW', category: 'Interest' });

    // Transfers: savings contribution, credit card payment, loan payment
    if (!skip(3)) addPair('checking', 'savings', inMonth(3), 500, 'TRANSFER TO SAVINGS', 'internal transfer');
    if (!skip(25)) addPair('checking', 'credit', inMonth(25), 600, 'CREDIT CARD PAYMENT', 'internal transfer');
    if (!skip(6)) addPair('checking', 'loan', inMonth(6), 350, 'AUTO LOAN PAYMENT', 'internal transfer');

    // Credit card variable spending
    const groceryStores = ['whole foods', 'trader joes'];
    for (let i = 0; i < 4; i++) {
      const d = 3 + i * 7;
      if (!skip(d)) add({ accountKey: 'credit', date: inMonth(d), amount: -randBetween(45, 110), description: 'GROCERY PURCHASE', merchant: groceryStores[i % 2], flow: 'OUTFLOW', category: 'Groceries' });
    }
    const restaurants = ['chipotle', 'local thai', 'burger barn', 'sushi go'];
    for (let i = 0; i < 4; i++) {
      const d = 5 + i * 6;
      if (!skip(d)) add({ accountKey: 'credit', date: inMonth(d), amount: -randBetween(15, 60), description: 'RESTAURANT', merchant: restaurants[i], flow: 'OUTFLOW', category: 'Dining' });
    }
    for (let i = 0; i < 2; i++) {
      const d = 8 + i * 12;
      if (!skip(d)) add({ accountKey: 'credit', date: inMonth(d), amount: -randBetween(35, 55), description: 'FUEL', merchant: 'shell gas', flow: 'OUTFLOW', category: 'Transport' });
    }
    if (!skip(21)) add({ accountKey: 'credit', date: inMonth(21), amount: -randBetween(25, 35), description: 'MOVIE TICKETS', merchant: 'amc theatres', flow: 'OUTFLOW', category: 'Entertainment' });
    if (!skip(11)) add({ accountKey: 'credit', date: inMonth(11), amount: -randBetween(30, 150), description: 'ONLINE ORDER', merchant: 'amazon', flow: 'OUTFLOW', category: 'Shopping' });
  }

  // Planted anomalies
  add({ accountKey: 'credit', date: utc(2026, 6, 14), amount: -385, description: 'MICHELIN BISTRO', merchant: 'michelin bistro', flow: 'OUTFLOW', category: 'Dining' });
  add({ accountKey: 'credit', date: utc(2026, 7, 8), amount: -2350, description: 'ONLINE ORDER - LAPTOP', merchant: 'amazon', flow: 'OUTFLOW', category: 'Shopping' });

  // Final balances = opening + sum of that account's transactions.
  const finals = new Map<string, number>(accountDefs.map((a) => [a.key, a.opening]));
  for (const t of txns) {
    finals.set(t.accountKey, Math.round(((finals.get(t.accountKey) ?? 0) + t.amount) * 100) / 100);
  }

  const accountIds = new Map<string, string>();
  for (const def of accountDefs) {
    const row = await prisma.account.create({
      data: {
        externalId: `fixture-${def.key}`,
        connectorType: 'SIMPLEFIN',
        institution: def.institution,
        name: def.name,
        type: def.type,
        currency: 'USD',
        balance: def.key === 'brokerage' ? 16650 : (finals.get(def.key) ?? 0),
        balanceDate: today,
        isStale: false,
      },
    });
    accountIds.set(def.key, row.id);
  }

  await prisma.transaction.createMany({
    data: txns.map((t) => ({
      id: t.id,
      accountId: accountIds.get(t.accountKey) as string,
      externalId: `fixture-${t.id}`,
      date: t.date,
      amount: t.amount,
      description: t.description,
      normalizedMerchant: t.merchant,
      flow: t.flow,
      categoryId: t.category === null ? null : categories.get(t.category),
      categorySource: 'MANUAL' as const,
      source: 'SIMPLEFIN' as const,
    })),
  });
  for (const t of txns) {
    if (t.pairWith !== undefined) {
      await prisma.transaction.update({ where: { id: t.id }, data: { transferPairId: t.pairWith } });
    }
  }

  // Brokerage: no transactions; month-end snapshots carry its market growth.
  // Other accounts get no snapshots, exercising transaction reconstruction.
  const brokerageValues = [15150, 15420, 15290, 15610, 15840, 16020, 16310, 16650];
  const snapshotMonths = months.slice(0, -1); // month-ends Nov 2025 – Jun 2026
  await prisma.balanceSnapshot.createMany({
    data: snapshotMonths.map(([y, m], i) => ({
      accountId: accountIds.get('brokerage') as string,
      date: new Date(Date.UTC(y, m, 0, 23, 59, 59)), // last day of month
      balance: brokerageValues[i],
    })),
  });

  // Tracked subscriptions: SimpleFIN's own bill (yearly, no fixture charge
  // yet — pure countdown), and Netflix registered at the OLD price so the
  // fixture's June price hike exercises drift detection.
  await prisma.trackedSubscription.createMany({
    data: [
      {
        name: 'SimpleFIN Bridge',
        merchantPattern: 'simplefin',
        expectedAmount: 15,
        cadence: 'YEARLY' as const,
        anchorDate: utc(2026, 8, 1),
        notes: 'Bank data feed subscription (~$15/yr).',
      },
      {
        name: 'Netflix',
        merchantPattern: 'netflix',
        expectedAmount: 15.99,
        cadence: 'MONTHLY' as const,
        anchorDate: utc(2025, 11, 10),
      },
    ],
  });

  // A synthetic successful sync so the health panel has fixture history.
  await prisma.syncLog.create({
    data: {
      connectorType: 'SIMPLEFIN',
      startedAt: today,
      finishedAt: today,
      ok: true,
      feedErrors: [],
      accountsSeen: 5,
      transactionsImported: txns.length,
      transactionsSkipped: 0,
      rulesApplied: 0,
      transfersLinked: 0,
    },
  });

  const counts = {
    accounts: await prisma.account.count(),
    categories: await prisma.category.count(),
    transactions: await prisma.transaction.count(),
    snapshots: await prisma.balanceSnapshot.count(),
    trackedSubscriptions: await prisma.trackedSubscription.count(),
  };
  console.log('Seeded fixture data:', counts);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
