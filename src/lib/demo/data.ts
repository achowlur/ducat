import type { PrismaClient } from '../../generated/prisma/client';

/**
 * Invented demo data, dated RELATIVE TO `now`, for `npm run db:seed`, the
 * README screenshots and the public demo.
 *
 * Why relative: the screens are gated to the month being LIVED IN — the
 * goals, readiness, pace and commitments panels on /insights, Overview's
 * spending block — so a fixture pinned to a fixed date renders an empty
 * current month on every day after it was written. Everything here is
 * computed from `now`: 24 complete months of history plus the current month
 * up to today, month-end investment snapshots inside every period, and the
 * Settings the Insights panels read.
 *
 * Why it looks the way it does: each piece exists because a screen needs it.
 * Payroll and rent make cash flow; weekly groceries and rising dining make a
 * category DRIFT; a subscription that changed price two months ago, and a
 * tracked copy at the old price, make price drift; a one-off purchase makes an
 * anomaly; a tagged trip makes the TRIPS rows; a fronted dinner repaid by Zelle
 * makes a reimbursement; three P2P payments await confirmation — one matching
 * a past amount, one covered by a payee rule, one from someone new — so every
 * kind of suggestion (and no suggestion) is on screen; one uncategorized
 * purchase keeps the review panel honest.
 *
 * NOTHING HERE IS REAL: the person, employer, landlord, payees, merchants,
 * institutions and amounts are invented; every account mask, the card's
 * included, is in the synthetic ...000N series, per docs/conventions/publishing.md
 * (the privacy scan reserves 1234 for card text, never an ellipsis mask). Deterministic for a given
 * `now` (a seeded LCG), so a screenshot retaken the same day is identical.
 */

export const DEMO_HISTORY_MONTHS = 24;

type Flow = 'INFLOW' | 'OUTFLOW' | 'TRANSFER';
type AccountType = 'DEPOSITORY' | 'CREDIT' | 'INVESTMENT' | 'LOAN';

export interface DemoAccount {
  key: string;
  name: string;
  institution: string;
  type: AccountType;
  balance: number;
}

export interface DemoTxn {
  id: string;
  accountKey: string;
  date: Date;
  amount: number;
  description: string;
  merchant: string;
  flow: Flow;
  category: string | null;
  categorySource: 'MANUAL' | 'RULE' | 'AGGREGATOR';
  pairWith?: string;
  reimburses?: string;
  groupLabel?: string;
}

export interface DemoPlan {
  now: Date;
  categories: { name: string; isIncome: boolean }[];
  accounts: DemoAccount[];
  txns: DemoTxn[];
  snapshots: { accountKey: string; date: Date; balance: number }[];
  rules: { matchField: 'DESCRIPTION'; matchValue: string; category: string }[];
  tracked: { name: string; merchantPattern: string; expectedAmount: number; cadence: 'MONTHLY' | 'YEARLY'; anchorDate: Date }[];
  /** Setting rows; `{account:key}` inside a value is resolved to that account's id when written. */
  settings: { key: string; value: unknown }[];
  syncTimes: Date[];
}

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const noon = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d, 12));
const daysIn = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const monthKey = (y: number, m0: number) => `${y}-${String(m0 + 1).padStart(2, '0')}`;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const mmdd = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
/** A rail reference in the privacy scan's synthetic WFCT shape (WFCT, seven digits, one character). */
const refCode = (n: number, tail: string) => 'WFCT' + String(n).padStart(7, '0') + tail;

export function buildDemoData(now: Date): DemoPlan {
  let lcg = 20260916;
  const rand = () => {
    lcg = (lcg * 1_103_515_245 + 12_345) % 2_147_483_648;
    return lcg / 2_147_483_648;
  };
  const between = (lo: number, hi: number) => round2(lo + rand() * (hi - lo));

  // A nightly sync at 23:16 UTC for the last fortnight, none after `now`. The
  // data stops at the NEWEST sync's day: a row dated after the sync that
  // imported it would be a transaction nobody could have fetched yet.
  const syncTimes: Date[] = [];
  for (let back = 14; back >= 0; back -= 1) {
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back, 23, 16));
    if (t.getTime() <= now.getTime()) syncTimes.push(t);
  }
  const newestSync = syncTimes[syncTimes.length - 1];
  const today = noon(newestSync.getUTCFullYear(), newestSync.getUTCMonth(), newestSync.getUTCDate());
  const cy = today.getUTCFullYear();
  const cm = today.getUTCMonth();
  const months: { y: number; m0: number; index: number; current: boolean }[] = [];
  for (let back = DEMO_HISTORY_MONTHS; back >= 0; back -= 1) {
    const d = new Date(Date.UTC(cy, cm - back, 1));
    months.push({ y: d.getUTCFullYear(), m0: d.getUTCMonth(), index: DEMO_HISTORY_MONTHS - back, current: back === 0 });
  }

  const txns: DemoTxn[] = [];
  let seq = 0;
  const add = (t: Omit<DemoTxn, 'id' | 'categorySource'> & { categorySource?: DemoTxn['categorySource'] }): string => {
    const id = `demo_${String(++seq).padStart(5, '0')}`;
    txns.push({ categorySource: 'MANUAL', ...t, id });
    return id;
  };
  const pair = (from: string, to: string, date: Date, amount: number, outText: string, inText: string) => {
    const a = add({ accountKey: from, date, amount: -amount, description: outText, merchant: 'online transfer', flow: 'TRANSFER', category: null });
    const b = add({ accountKey: to, date, amount, description: inText, merchant: 'online transfer', flow: 'TRANSFER', category: null, pairWith: a });
    txns.find((t) => t.id === a)!.pairWith = b;
  };
  /** A date in the month, or null when it falls after today (or past the month's end). */
  const on = (mo: (typeof months)[number], day: number): Date | null => {
    if (day > daysIn(mo.y, mo.m0)) day = daysIn(mo.y, mo.m0);
    const d = noon(mo.y, mo.m0, day);
    return d.getTime() > today.getTime() ? null : d;
  };

  const cardSpendByMonth: number[] = [];
  const lastComplete = months[months.length - 2];

  for (const mo of months) {
    let card = 0;
    const spend = (day: number, amount: number, description: string, merchant: string, category: string, extra: Partial<DemoTxn> = {}) => {
      const d = on(mo, day);
      if (d === null) return;
      add({ accountKey: 'card', date: d, amount: -amount, description, merchant, flow: 'OUTFLOW', category, ...extra });
      card += amount;
    };
    const checking = (day: number, amount: number, description: string, merchant: string, category: string | null, flow: Flow) => {
      const d = on(mo, day);
      if (d !== null) add({ accountKey: 'checking', date: d, amount, description, merchant, flow, category });
    };
    // Seasonal: electricity peaks in summer and winter.
    const season = Math.abs(Math.cos(((mo.m0 + 0.5) / 12) * 2 * Math.PI));
    // Dining creeps up over the last quarter — the digest's category drift.
    const diningLift = mo.index >= DEMO_HISTORY_MONTHS - 2 ? 1.35 : 1;

    checking(1, 2650, 'NORTHWIND LABS PAYROLL', 'northwind labs', 'Income', 'INFLOW');
    checking(15, 2650, 'NORTHWIND LABS PAYROLL', 'northwind labs', 'Income', 'INFLOW');
    // A yearly bonus in March, and a raise at each year's start.
    if (mo.m0 === 2) checking(20, 3800, 'NORTHWIND LABS BONUS', 'northwind labs', 'Income', 'INFLOW');
    if (mo.m0 === 0 && mo.index > 0) checking(15, 120 * Math.floor(mo.index / 12), 'NORTHWIND LABS PAYROLL ADJ', 'northwind labs', 'Income', 'INFLOW');
    checking(1, -1850, 'MAPLE COURT APARTMENTS RENT', 'maple court apartments', 'Rent & Housing', 'OUTFLOW');
    checking(12, -round2(78 + 62 * season + between(-6, 6)), 'CITYLIGHT ELECTRIC', 'citylight electric', 'Utilities', 'OUTFLOW');
    checking(17, -65, 'BRIGHTWAVE INTERNET', 'brightwave internet', 'Utilities', 'OUTFLOW');
    checking(22, -45, 'PARCEL MOBILE', 'parcel mobile', 'Utilities', 'OUTFLOW');
    const interest = on(mo, 28);
    if (interest !== null) add({ accountKey: 'savings', date: interest, amount: between(24, 31), description: 'INTEREST PAYMENT', merchant: 'harbor savings', flow: 'INFLOW', category: 'Income' });

    const t3 = on(mo, 3);
    if (t3 !== null) pair('checking', 'savings', t3, 450, 'TRANSFER TO SAVINGS ...0002', 'TRANSFER FROM CHECKING ...0001');
    const t5 = on(mo, 5);
    if (t5 !== null) pair('checking', 'brokerage', t5, 300, 'NORTHWIND BROKERAGE CONTRIBUTION', 'ELECTRONIC CONTRIBUTION RECEIVED');
    const t6 = on(mo, 6);
    if (t6 !== null) pair('checking', 'loan', t6, 340, 'AUTO LOAN PAYMENT ...0005', 'PAYMENT RECEIVED - THANK YOU');
    const t8 = on(mo, 8);
    if (t8 !== null) pair('checking', 'ira', t8, 250, 'ROTH IRA CONTRIBUTION', 'CONTRIBUTION RECEIVED');
    const prior = cardSpendByMonth[cardSpendByMonth.length - 1];
    const t25 = on(mo, 25);
    if (t25 !== null && prior !== undefined) pair('checking', 'card', t25, round2(prior), 'RIVERSTONE CARD PAYMENT ...0006', 'PAYMENT THANK YOU');

    // Subscriptions: the streaming price rose two months before the current one.
    const streaming = mo.index >= DEMO_HISTORY_MONTHS - 2 ? 17.99 : 15.49;
    spend(9, streaming, 'STREAMFLIX.COM', 'streamflix', 'Subscriptions');
    spend(14, 10.99, 'TUNEBOX MUSIC', 'tunebox', 'Subscriptions');
    spend(4, 34.99, 'IRONLEAF FITNESS', 'ironleaf fitness', 'Subscriptions');

    // Everyday spending lands on uneven days, as it does in life — on fixed
    // days the recurring detector reads a grocery store as a subscription.
    const jitter = (base: number) => Math.max(1, base + Math.floor(rand() * 5) - 2);
    for (const [i, day] of [3, 10, 17, 24].entries()) {
      spend(jitter(day), between(58, 124), i % 2 === 0 ? 'GREENBASKET MARKET' : 'CORNER GROCER', i % 2 === 0 ? 'greenbasket market' : 'corner grocer', 'Groceries');
    }
    const restaurants = ['little saigon kitchen', 'ember pizza co', 'the copper table', 'noodle harbor', 'blue fern cafe'];
    for (let i = 0; i < 6; i++) {
      const name = restaurants[(mo.index + i) % restaurants.length];
      spend(jitter(3 + i * 5), round2(between(16, 58) * diningLift), name.toUpperCase(), name, 'Dining');
    }
    // Fuel whenever the tank runs low: anywhere in each half of the month, at
    // whatever the fill costs — two days of jitter still read as "biweekly".
    spend(1 + Math.floor(rand() * 14), between(26, 64), 'SUMMIT FUEL', 'summit fuel', 'Gas');
    spend(15 + Math.floor(rand() * 13), between(26, 64), 'SUMMIT FUEL', 'summit fuel', 'Gas');
    // Holiday shopping in December, and a pricier summer.
    if (mo.m0 === 11) spend(jitter(12), between(280, 420), 'ORBITMART ONLINE', 'orbitmart', 'Gifts');
    if (mo.m0 === 6 || mo.m0 === 7) spend(jitter(27), between(90, 160), 'LAKESIDE OUTFITTERS', 'lakeside outfitters', 'Shopping');
    spend(11, between(12, 26), 'METRORIDE TRANSIT', 'metroride', 'Transport');
    spend(19, between(24, 140), 'ORBITMART ONLINE', 'orbitmart', 'Shopping');
    if (mo.index % 3 === 1) spend(26, between(18, 44), 'WELLSPRING PHARMACY', 'wellspring pharmacy', 'Health');
    if (mo.index % 2 === 0) spend(24, between(22, 48), 'STARLIGHT CINEMAS', 'starlight cinemas', 'Entertainment');


    // A tagged trip four months back — the TRIPS rows and the ?group= filter.
    if (mo.index === DEMO_HISTORY_MONTHS - 4) {
      const label = `Coast trip ${mo.y}`;
      spend(10, 386.2, 'SKYLARK AIR', 'skylark air', 'Travel', { groupLabel: label });
      spend(12, 512.75, 'SEAGLASS INN', 'seaglass inn', 'Travel', { groupLabel: label });
      spend(13, 94.3, 'DRIFTWOOD OYSTER BAR', 'driftwood oyster bar', 'Dining', { groupLabel: label });
    }

    // A fronted group dinner, half repaid by Zelle and LINKED to it.
    if (mo === lastComplete) {
      const d = on(mo, 18);
      const r = on(mo, 20);
      if (d !== null && r !== null) {
        const dinner = add({ accountKey: 'card', date: d, amount: -186.4, description: 'HARBOR GRILL', merchant: 'harbor grill', flow: 'OUTFLOW', category: 'Dining' });
        card += 186.4;
        add({ accountKey: 'checking', date: r, amount: 93.2, description: `ZELLE FROM JORDAN PARK ON ${mmdd(r)} REF # WFCT0000001J`, merchant: 'zelle from jordan park', flow: 'INFLOW', category: null, reimburses: dinner });
      }
    }

    cardSpendByMonth.push(card);
  }

  // --- the last few days --------------------------------------------------------
  // What /insights opens on is the month being lived in, so the one-off (the
  // anomaly and the digest's ONE_OFF) and a short tagged trip (the TRIPS rows)
  // sit in the days just before today. Early in a month they fall in the prior
  // one, which is still one tap away.
  const daysAgo = (n: number) => new Date(today.getTime() - n * DAY_MS);
  const cardTxn = (date: Date, amount: number, description: string, category: string, groupLabel?: string) =>
    add({ accountKey: 'card', date, amount: -amount, description, merchant: description.toLowerCase(), flow: 'OUTFLOW', category, groupLabel });
  cardTxn(daysAgo(2), 1249, 'BRIGHTLINE ELECTRONICS', 'Shopping');
  const weekend = `Mountain weekend ${daysAgo(6).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
  cardTxn(daysAgo(6), 268.4, 'PINECREST LODGE', 'Travel', weekend);
  cardTxn(daysAgo(5), 74.25, 'TRAILHEAD TAVERN', 'Dining', weekend);
  cardTxn(daysAgo(5), 41.8, 'SUMMIT FUEL', 'Gas', weekend);

  // --- P2P -----------------------------------------------------------------
  // Utilities split with a roommate: the same amount every month, confirmed by
  // hand — so the latest one arrives with a SAME AMOUNT suggestion.
  const alex = months
    .map((mo) => on(mo, 20))
    .filter((d): d is Date => d !== null);
  alex.forEach((d, i) => {
    const latest = i === alex.length - 1;
    add({
      accountKey: 'checking', date: d, amount: -58.4,
      description: `ZELLE TO ALEX RIVERA ON ${mmdd(d)} REF # ${refCode(100 + i, 'A')}`,
      merchant: 'zelle to alex rivera', flow: 'OUTFLOW',
      category: latest ? null : 'Utilities', categorySource: latest ? 'AGGREGATOR' : 'MANUAL',
    });
  });
  // Gifts to a sibling, categorized by a payee RULE (from before P2P rules
  // became suggestions) — varying amounts, so the latest gets a RULE suggestion.
  const samAmounts = [60, 120, 45, 85, 150, 70, 95, 40];
  const sam = months
    .filter((mo) => mo.index % 3 === 2)
    .map((mo) => on(mo, 9))
    .filter((d): d is Date => d !== null);
  sam.forEach((d, i) => {
    const latest = i === sam.length - 1;
    add({
      accountKey: 'checking', date: d, amount: -(latest ? 210 : samAmounts[i % samAmounts.length]),
      description: `ZELLE TO SAM LEE ON ${mmdd(d)} REF # ${refCode(200 + i, 'S')}`,
      merchant: 'zelle to sam lee', flow: 'OUTFLOW',
      category: latest ? null : 'Gifts', categorySource: latest ? 'AGGREGATOR' : 'RULE',
    });
  });
  // Someone new: no history, no rule — it waits for a person to pick.
  add({
    accountKey: 'checking', date: today, amount: -35,
    description: 'VENMO PAYMENT 1000000007 CASEY MORGAN', merchant: 'venmo payment',
    flow: 'OUTFLOW', category: null, categorySource: 'AGGREGATOR',
  });
  // And one card purchase no rule knows, for the review panel.
  add({
    accountKey: 'card', date: today, amount: -42.5,
    description: 'SQ *LANTERN POTTERY STUDIO', merchant: 'lantern pottery studio',
    flow: 'OUTFLOW', category: null, categorySource: 'AGGREGATOR',
  });

  // --- balances --------------------------------------------------------------
  txns.sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id));
  const sumOf = (key: string) => round2(txns.filter((t) => t.accountKey === key).reduce((s, t) => s + t.amount, 0));
  // Checking opens high enough that its running balance never dips below zero.
  let run = 0;
  let low = 0;
  for (const t of txns) {
    if (t.accountKey !== 'checking') continue;
    run += t.amount;
    low = Math.min(low, run);
  }
  const checkingOpening = round2(Math.max(4200, -low + 2500));

  const snapshots: DemoPlan['snapshots'] = [];
  const invest = (key: string, start: number, monthly: number): number => {
    let value = start;
    for (const mo of months) {
      value = round2(value * (1 + between(-0.028, 0.041)) + monthly);
      const date = mo.current ? today : new Date(Date.UTC(mo.y, mo.m0 + 1, 0, 23, 59, 59));
      snapshots.push({ accountKey: key, date, balance: value });
    }
    return value;
  };
  const brokerage = invest('brokerage', 31800, 300);
  const ira = invest('ira', 18400, 250);

  const accounts: DemoAccount[] = [
    { key: 'checking', name: 'Everyday Checking ...0001', institution: 'Harbor Community Bank', type: 'DEPOSITORY', balance: round2(checkingOpening + sumOf('checking')) },
    { key: 'savings', name: 'High-Yield Savings ...0002', institution: 'Harbor Community Bank', type: 'DEPOSITORY', balance: round2(9600 + sumOf('savings')) },
    { key: 'card', name: 'Riverstone Rewards Visa ...0006', institution: 'Riverstone Card Services', type: 'CREDIT', balance: round2(-640 + sumOf('card')) },
    { key: 'brokerage', name: 'Individual Brokerage ...0003', institution: 'Northwind Investments', type: 'INVESTMENT', balance: brokerage },
    { key: 'ira', name: 'Roth IRA ...0004', institution: 'Northwind Investments', type: 'INVESTMENT', balance: ira },
    { key: 'loan', name: 'Auto Loan ...0005', institution: 'Harbor Community Bank', type: 'LOAN', balance: round2(-16800 + sumOf('loan')) },
  ];
  // Every other account gets month-end snapshots too, as a live feed writes
  // them: without one, a card's and a loan's history is only "estimated".
  for (const key of ['checking', 'savings', 'card', 'loan']) {
    const account = accounts.find((a) => a.key === key)!;
    for (const mo of months.filter((m) => !m.current)) {
      const end = new Date(Date.UTC(mo.y, mo.m0 + 1, 0, 23, 59, 59));
      const after = txns.filter((t) => t.accountKey === key && t.date.getTime() > end.getTime()).reduce((s, t) => s + t.amount, 0);
      snapshots.push({ accountKey: key, date: end, balance: round2(account.balance - after) });
    }
    snapshots.push({ accountKey: key, date: today, balance: account.balance });
  }

  const houseTargetMonth = new Date(Date.UTC(cy, cm + 30, 1));
  return {
    now,
    categories: [
      { name: 'Income', isIncome: true },
      ...['Rent & Housing', 'Groceries', 'Dining', 'Utilities', 'Subscriptions', 'Gas', 'Transport', 'Shopping', 'Health', 'Entertainment', 'Travel', 'Gifts'].map(
        (name) => ({ name, isIncome: false }),
      ),
    ],
    accounts,
    txns,
    snapshots,
    rules: [{ matchField: 'DESCRIPTION', matchValue: 'zelle to sam lee', category: 'Gifts' }],
    tracked: [
      // Registered at the OLD price, so the price rise reads as drift.
      { name: 'Streamflix', merchantPattern: 'streamflix', expectedAmount: 15.49, cadence: 'MONTHLY', anchorDate: noon(months[0].y, months[0].m0, 9) },
      // A yearly renewal about three weeks out — a dated commitment.
      { name: 'Domain renewal', merchantPattern: 'namekeep', expectedAmount: 24, cadence: 'YEARLY', anchorDate: new Date(today.getTime() + 21 * DAY_MS - 365 * DAY_MS) },
    ],
    settings: [
      {
        key: 'goals.savings',
        value: [
          { id: 'house-deposit', name: 'House deposit', target: 69000, housePrice: 300000, targetMonth: monthKey(houseTargetMonth.getUTCFullYear(), houseTargetMonth.getUTCMonth()), cash: true, accountIds: [] },
          { id: 'emergency-fund', name: 'Emergency fund', target: 30000, accountIds: ['{account:savings}'] },
        ],
      },
      {
        key: 'readiness.house',
        value: { savingsFloor: 900, termYears: 30, taxPctYr: 1.1, insurancePctYr: 0.35, pmiPctYr: 0.5, closingPct: 3, downPct: 20, ratePct: 6.4, asOf: isoDay(new Date(today.getTime() - 6 * DAY_MS)) },
      },
    ],
    syncTimes,
  };
}

/**
 * Write a plan into an EMPTY database (the caller wipes first) and return the
 * id of every account by key. Rows only — the rule pack and insights are the
 * caller's next steps, through the same functions a real instance uses.
 */
export async function writeDemoData(prisma: PrismaClient, plan: DemoPlan): Promise<Map<string, string>> {
  const categoryIds = new Map<string, string>();
  for (const c of plan.categories) {
    categoryIds.set(c.name, (await prisma.category.create({ data: c })).id);
  }
  const accountIds = new Map<string, string>();
  const newestSync = plan.syncTimes[plan.syncTimes.length - 1];
  for (const a of plan.accounts) {
    const row = await prisma.account.create({
      data: {
        externalId: `demo-${a.key}`, connectorType: 'SIMPLEFIN', institution: a.institution, name: a.name,
        type: a.type, currency: 'USD', balance: a.balance, balanceDate: newestSync, isStale: false,
      },
    });
    accountIds.set(a.key, row.id);
  }
  await prisma.transaction.createMany({
    data: plan.txns.map((t) => ({
      id: t.id, accountId: accountIds.get(t.accountKey)!, externalId: `demo-${t.id}`, date: t.date,
      amount: t.amount, description: t.description, normalizedMerchant: t.merchant, flow: t.flow,
      categoryId: t.category === null ? null : categoryIds.get(t.category)!, categorySource: t.categorySource,
      source: 'SIMPLEFIN' as const, groupLabel: t.groupLabel ?? null,
    })),
  });
  // Self-references after every row exists.
  for (const t of plan.txns) {
    if (t.pairWith !== undefined || t.reimburses !== undefined) {
      await prisma.transaction.update({
        where: { id: t.id },
        data: { transferPairId: t.pairWith ?? null, reimbursesId: t.reimburses ?? null },
      });
    }
  }
  await prisma.balanceSnapshot.createMany({
    data: plan.snapshots.map((s) => ({ accountId: accountIds.get(s.accountKey)!, date: s.date, balance: s.balance })),
  });
  for (const r of plan.rules) {
    await prisma.rule.create({
      data: { priority: 50, matchField: r.matchField, matchOperator: 'CONTAINS', matchValue: r.matchValue, setCategoryId: categoryIds.get(r.category)!, enabled: true },
    });
  }
  await prisma.trackedSubscription.createMany({ data: plan.tracked });
  for (const s of plan.settings) {
    const value = JSON.stringify(s.value).replace(/\{account:([a-z]+)\}/g, (_, key: string) => accountIds.get(key)!);
    await prisma.setting.upsert({ where: { key: s.key }, create: { key: s.key, value }, update: { value } });
  }
  await prisma.syncLog.createMany({
    data: plan.syncTimes.map((t, i) => ({
      connectorType: 'SIMPLEFIN', startedAt: new Date(t.getTime() - 4000), finishedAt: t, ok: true, feedErrors: [],
      accountsSeen: plan.accounts.length, transactionsImported: i === plan.syncTimes.length - 1 ? 4 : 3,
      transactionsSkipped: 0, rulesApplied: 0, transfersLinked: 0,
    })),
  });
  return accountIds;
}
