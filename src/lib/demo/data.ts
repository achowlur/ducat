import type { PrismaClient } from '../../generated/prisma/client';

/**
 * Invented demo data, dated RELATIVE TO `now`, for `npm run db:seed`, the
 * README screenshots and the public demo.
 *
 * Why relative: the screens are gated to the month being LIVED IN — the
 * goals, readiness, pace and commitments panels on /insights, Overview's
 * spending block — so a fixture pinned to a fixed date renders an empty
 * current month on every day after it was written. Everything here is
 * computed from `now`: eleven years of complete months plus the current month
 * up to today, month-end snapshots for every account inside every period, and
 * the Settings the Insights panels read.
 *
 * The eleven years are one life, so the long screens have a shape to show: a
 * first job a decade ago with a raise every January, rent rising with it, a
 * student loan paid down to almost nothing, saving and investing that grow
 * with the pay (a yearly bonus moved into the brokerage, the lump sum the
 * goal's deposit rule must ignore), and markets with a crash and a bad year
 * in them. The net worth goal is far enough off that saving alone and saving
 * with markets land about a decade apart, which is what its chart is for.
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

export const DEMO_HISTORY_MONTHS = 132;

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
/** Transfer and repayment links written per statement (three bound values a row, well inside SQLite's limit). */
const LINKS_PER_STATEMENT = 250;
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
  // A second card, opened four months ago, takes the fuel from then on, so
  // the months before it hold none of its spending: the savings pace,
  // readiness and the runway name them (insights/recentMonths.ts).
  const fuelCardFrom = DEMO_HISTORY_MONTHS - 4;
  const fuelSpendByMonth: number[] = [];
  // The cancelled gym's last charge (see the subscriptions below). Day 28 at
  // most, so it bills in every month.
  const gymLast = new Date(today.getTime() - 40 * DAY_MS);
  const gymDay = Math.min(28, gymLast.getUTCDate());
  const lastComplete = months[months.length - 2];

  const firstYear = months[0].y;
  // The savings account's balance as the months go, so its interest is a
  // RATE on it: the net worth goal reads a cash account's yield from what it
  // was paid, and a fixed amount read as a high-yield account paying 0.6%.
  let savingsHeld = 3000;
  for (const mo of months) {
    let card = 0;
    let fuel = 0;
    /** Calendar years since the first, so raises and rent rises land in January. */
    const yrs = mo.y - firstYear;
    /** Everyday spending grows with the pay, from three quarters of today's. */
    const life = 0.75 + 0.025 * yrs;
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

    // Paid twice a month, with a raise every January, and a new job three
    // months back at a tenth more: the paces count the old job's months at
    // the new pay (ui/payLevel.ts, a job change).
    const newJob = mo.index >= DEMO_HISTORY_MONTHS - 3;
    const employer = newJob ? { text: 'LAKESHORE ANALYTICS', key: 'lakeshore analytics' } : { text: 'NORTHWIND LABS', key: 'northwind labs' };
    const pay = round2(1900 * Math.pow(1.035, yrs) * (newJob ? 1.1 : 1));
    checking(1, pay, `${employer.text} PAYROLL`, employer.key, 'Income', 'INFLOW');
    checking(15, pay, `${employer.text} PAYROLL`, employer.key, 'Income', 'INFLOW');
    // A yearly bonus in March, most of it moved straight into the brokerage:
    // the lump sum the net worth goal's deposit rule must not read as a habit.
    if (mo.m0 === 2) {
      const bonus = 2400 + 150 * yrs;
      checking(20, bonus, `${employer.text} BONUS`, employer.key, 'Income', 'INFLOW');
      const moved = on(mo, 21);
      if (moved !== null) pair('checking', 'brokerage', moved, round2(bonus * 0.8), 'NORTHWIND BROKERAGE CONTRIBUTION', 'ELECTRONIC CONTRIBUTION RECEIVED');
    }
    // A tax refund each April: income from no regular source, which the
    // saving paces leave out with the bonus (insights/oneOffPay.ts).
    if (mo.m0 === 3) checking(16, round2(480 + 35 * yrs), 'US TREASURY TAX REFUND', 'us treasury tax refund', 'Income', 'INFLOW');
    checking(1, -(1300 + 50 * yrs), 'MAPLE COURT APARTMENTS RENT', 'maple court apartments', 'Rent & Housing', 'OUTFLOW');
    checking(12, -round2(78 + 62 * season + between(-6, 6)), 'CITYLIGHT ELECTRIC', 'citylight electric', 'Utilities', 'OUTFLOW');
    checking(17, -65, 'BRIGHTWAVE INTERNET', 'brightwave internet', 'Utilities', 'OUTFLOW');
    checking(22, -45, 'PARCEL MOBILE', 'parcel mobile', 'Utilities', 'OUTFLOW');
    // A family plan billed in full and split three ways: two people repay
    // their thirds by Zelle days later, LINKED to the bill, for the last six
    // complete months and this one, so Insights bills the operator's share (insights/sharedPlans.ts).
    // Last month only one of them has repaid, so once this month's bill is in
    // the plan asks about that one ("Not split"). Earlier months were never
    // linked and stay at full price: nothing is backfilled.
    const familyDay = on(mo, 4);
    if (familyDay !== null) {
      const bill = add({ accountKey: 'checking', date: familyDay, amount: -110, description: 'KESTREL WIRELESS FAMILY PLAN', merchant: 'kestrel wireless', flow: 'OUTFLOW', category: 'Utilities' });
      if (mo.index >= DEMO_HISTORY_MONTHS - 6) {
        for (const [who, day] of [['RILEY CHEN', 6], ['MORGAN DIAZ', 7]] as const) {
          if (mo === lastComplete && who === 'MORGAN DIAZ') continue;
          const r = on(mo, day);
          if (r === null) continue;
          const ref = `WFCT${String(mo.index * 2 + day).padStart(7, '0')}K`;
          add({ accountKey: 'checking', date: r, amount: 36.5, description: `ZELLE FROM ${who} ON ${mmdd(r)} REF # ${ref}`, merchant: `zelle from ${who.toLowerCase()}`, flow: 'INFLOW', category: null, reimburses: bill });
        }
      }
    }
    // Saving and investing grow with the pay; the loan payment does not.
    const toSavings = Math.min(475, 200 + 25 * yrs);
    const t3 = on(mo, 3);
    if (t3 !== null) {
      pair('checking', 'savings', t3, toSavings, 'TRANSFER TO SAVINGS ...0002', 'TRANSFER FROM CHECKING ...0001');
      savingsHeld += toSavings;
    }
    // A high-yield account's rate: under 1% until rates rose four years ago,
    // about 4.2% a year since.
    const yearsAgo = (DEMO_HISTORY_MONTHS - 1 - mo.index) / 12;
    const apy = yearsAgo > 4 ? 0.9 : yearsAgo > 3.5 ? 2.5 : 4.2;
    const interest = on(mo, 28);
    if (interest !== null) {
      const paid = round2(savingsHeld * (Math.pow(1 + apy / 100, 1 / 12) - 1));
      add({ accountKey: 'savings', date: interest, amount: paid, description: 'INTEREST PAYMENT', merchant: 'harbor savings', flow: 'INFLOW', category: 'Income' });
      savingsHeld += paid;
    }
    const t5 = on(mo, 5);
    if (t5 !== null) pair('checking', 'brokerage', t5, 100 + 75 * yrs, 'NORTHWIND BROKERAGE CONTRIBUTION', 'ELECTRONIC CONTRIBUTION RECEIVED');
    const t6 = on(mo, 6);
    if (t6 !== null) pair('checking', 'loan', t6, 300, 'STUDENT LOAN PAYMENT ...0005', 'PAYMENT RECEIVED - THANK YOU');
    const t8 = on(mo, 8);
    if (t8 !== null) pair('checking', 'ira', t8, 200 + 10 * yrs, 'ROTH IRA CONTRIBUTION', 'CONTRIBUTION RECEIVED');
    const prior = cardSpendByMonth[cardSpendByMonth.length - 1];
    const t25 = on(mo, 25);
    if (t25 !== null && prior !== undefined) pair('checking', 'card', t25, round2(prior), 'RIVERSTONE CARD PAYMENT ...0006', 'PAYMENT THANK YOU');
    const priorFuel = fuelSpendByMonth[fuelSpendByMonth.length - 1];
    if (t25 !== null && priorFuel !== undefined && priorFuel > 0) pair('checking', 'fuelcard', t25, round2(priorFuel), 'SUMMIT REWARDS PAYMENT ...0007', 'PAYMENT THANK YOU');

    // Subscriptions: the streaming price rose two months before the current one.
    const streaming = mo.index >= DEMO_HISTORY_MONTHS - 2 ? 17.99 : 15.49;
    spend(9, streaming, 'STREAMFLIX.COM', 'streamflix', 'Subscriptions');
    // The music plan's descriptor changed eight months ago, as banks do
    // mid-plan; the detector follows it, so Insights lists ONE plan "billed
    // under 2 names" (recurring.ts, continues).
    if (mo.index < DEMO_HISTORY_MONTHS - 8) spend(14, 10.99, 'TUNEBOX MUSIC', 'tunebox', 'Subscriptions');
    else spend(14, 10.99, 'TUNEBOX PREMIUM', 'tunebox premium', 'Subscriptions');
    // The gym was cancelled: its last charge landed about forty days before
    // today and the next never came, while the card kept recording, so
    // Insights flags it MISSED (health/detectedSubscriptions.ts) without it
    // lapsing. Its billing day follows today so that holds on any date.
    const gymDate = on(mo, gymDay);
    if (gymDate !== null && gymDate.getTime() <= gymLast.getTime()) spend(gymDay, 34.99, 'IRONLEAF FITNESS', 'ironleaf fitness', 'Subscriptions');

    // Everyday spending lands on uneven days, as it does in life — on fixed
    // days the recurring detector reads a grocery store as a subscription.
    const jitter = (base: number) => Math.max(1, base + Math.floor(rand() * 5) - 2);
    for (const [i, day] of [3, 10, 17, 24].entries()) {
      spend(jitter(day), round2(between(58, 124) * life), i % 2 === 0 ? 'GREENBASKET MARKET' : 'CORNER GROCER', i % 2 === 0 ? 'greenbasket market' : 'corner grocer', 'Groceries');
    }
    const restaurants = ['little saigon kitchen', 'ember pizza co', 'the copper table', 'noodle harbor', 'blue fern cafe'];
    for (let i = 0; i < 6; i++) {
      const name = restaurants[(mo.index + i) % restaurants.length];
      spend(jitter(3 + i * 5), round2(between(16, 58) * diningLift * life), name.toUpperCase(), name, 'Dining');
    }
    // Coffee most mornings and a few desk lunches: many small rows, three or
    // four days apart, too close together for any cadence to read as a plan.
    // Coffee is a category of its own: filed under Dining, ten small cups a
    // month set that category's median at a cup, and an ordinary dinner read
    // as a one-off.
    for (const day of [2, 5, 8, 11, 13, 16, 19, 22, 25, 28]) {
      spend(Math.min(28, day + Math.floor(rand() * 2)), between(4.25, 7.4), 'DAILY GRIND COFFEE', 'daily grind coffee', 'Coffee');
    }
    for (const day of [6, 13, 21]) spend(jitter(day), round2(between(10.5, 16.9) * life), 'GREENLEAF SALADS', 'greenleaf salads', 'Dining');
    if (rand() < 0.7) spend(jitter(9), between(11, 34), 'ZIPRIDE TRIP', 'zipride', 'Transport');
    if (rand() < 0.5) spend(jitter(21), between(8, 26), 'ZIPRIDE TRIP', 'zipride', 'Transport');
    if (rand() < 0.6) spend(jitter(16), between(4, 18), 'CITYPARK METER', 'citypark', 'Transport');
    spend(jitter(7), round2(between(24, 71) * life), 'PAWS AND CLAWS SUPPLY', 'paws and claws supply', 'Shopping');
    if (mo.index % 2 === 1) spend(jitter(23), between(16, 96), 'OAKLINE HARDWARE', 'oakline hardware', 'Shopping');
    if (mo.index % 3 === 0) spend(jitter(18), between(12, 48), 'PAGEWISE BOOKS', 'pagewise books', 'Entertainment');
    if (mo.m0 % 3 === 1) spend(jitter(14), round2(between(45, 210) * life), 'THREADLINE CLOTHING', 'threadline', 'Shopping');
    if (mo.index % 4 === 2) spend(jitter(10), between(25, 60), 'HARBOR HEALTH CLINIC', 'harbor health clinic', 'Health');
    // A summer trip every year but the one tagged below: flights, a stay, meals out.
    if (mo.m0 === 6 && mo.index !== DEMO_HISTORY_MONTHS - 4) {
      const stay = ['SEAGLASS INN', 'CEDAR RIDGE LODGE', 'HARBORVIEW SUITES', 'MESA SPRINGS INN'][mo.y % 4];
      // Two airlines, alternate years: one fare a year at one carrier reads as a yearly plan.
      const air = mo.y % 2 === 0 ? 'SKYLARK AIR' : 'BLUEJET AIRWAYS';
      spend(jitter(8), round2(between(220, 410) * life), air, air.toLowerCase(), 'Travel');
      spend(jitter(12), round2(between(380, 640) * life), stay, stay.toLowerCase(), 'Travel');
      spend(jitter(14), round2(between(45, 120) * life), 'DRIFTWOOD OYSTER BAR', 'driftwood oyster bar', 'Dining');
    }
    // Fuel whenever the tank runs low: anywhere in each half of the month, at
    // whatever the fill costs — two days of jitter still read as "biweekly".
    const fill = (day: number, amount: number) => {
      if (mo.index < fuelCardFrom) return spend(day, amount, 'SUMMIT FUEL', 'summit fuel', 'Gas');
      const d = on(mo, day);
      if (d === null) return;
      add({ accountKey: 'fuelcard', date: d, amount: -amount, description: 'SUMMIT FUEL', merchant: 'summit fuel', flow: 'OUTFLOW', category: 'Gas' });
      fuel += amount;
    };
    fill(1 + Math.floor(rand() * 14), between(26, 64));
    fill(15 + Math.floor(rand() * 13), between(26, 64));
    // Holiday shopping in December, and a pricier summer.
    if (mo.m0 === 11) spend(jitter(12), between(280, 420), 'ORBITMART ONLINE', 'orbitmart', 'Gifts');
    // The summer splurge is the pottery studio the review panel's last
    // purchase comes back to under another spelling, so grouped review has a
    // payee to SUGGEST for (lib/sync/groupSuggest.ts, "like ...").
    if (mo.m0 === 6 || mo.m0 === 7) spend(jitter(27), between(90, 160), 'LANTERN POTTERY STUDIO #2', 'lantern pottery studio #2', 'Shopping');
    spend(11, between(12, 26), 'METRORIDE TRANSIT', 'metroride', 'Transport');
    spend(19, round2(between(24, 140) * life), 'ORBITMART ONLINE', 'orbitmart', 'Shopping');
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
    fuelSpendByMonth.push(fuel);
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
    .filter((mo) => mo.index >= DEMO_HISTORY_MONTHS - 36)
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
  // The month's market move: ordinary months, then a crash one March and a
  // bad year, so the net worth line and the markets' share have a shape.
  const marketMove = (mo: (typeof months)[number]): number => {
    if (mo.y === 2020 && mo.m0 === 2) return -0.12;
    if (mo.y === 2022 && mo.m0 <= 8) return between(-0.045, 0.018);
    return between(-0.028, 0.041);
  };
  /** Month-end values from the money that crossed into the account and the markets' move on it. */
  const invest = (key: string, start: number, fromIndex = 0): number => {
    let value = start;
    for (const mo of months.filter((m) => m.index >= fromIndex)) {
      const flows = txns
        .filter((t) => t.accountKey === key && t.date.getUTCFullYear() === mo.y && t.date.getUTCMonth() === mo.m0)
        .reduce((sum, t) => sum + t.amount, 0);
      value = round2(value * (1 + marketMove(mo)) + flows);
      const date = mo.current ? today : new Date(Date.UTC(mo.y, mo.m0 + 1, 0, 23, 59, 59));
      snapshots.push({ accountKey: key, date, balance: value });
    }
    return value;
  };
  const brokerage = invest('brokerage', 2000);
  const ira = invest('ira', 1500);
  // An old workplace plan rolled into an IRA, whose statements start two
  // years back with no opening at zero: before them its value is unknown and
  // left out, so the month it joins the total is named on Trends as
  // accounts joining, never as saving (ui/netWorthGrowth.ts).
  const rolloverFrom = DEMO_HISTORY_MONTHS - 24;
  const rollover = invest('rollover', 18_400, rolloverFrom);

  const accounts: DemoAccount[] = [
    { key: 'checking', name: 'Everyday Checking ...0001', institution: 'Harbor Community Bank', type: 'DEPOSITORY', balance: round2(checkingOpening + sumOf('checking')) },
    { key: 'savings', name: 'High-Yield Savings ...0002', institution: 'Harbor Community Bank', type: 'DEPOSITORY', balance: round2(3000 + sumOf('savings')) },
    { key: 'card', name: 'Riverstone Rewards Visa ...0006', institution: 'Riverstone Card Services', type: 'CREDIT', balance: round2(-640 + sumOf('card')) },
    { key: 'fuelcard', name: 'Summit Rewards Card ...0007', institution: 'Summit Card Services', type: 'CREDIT', balance: round2(sumOf('fuelcard')) },
    { key: 'brokerage', name: 'Individual Brokerage ...0003', institution: 'Northwind Investments', type: 'INVESTMENT', balance: brokerage },
    { key: 'ira', name: 'Roth IRA ...0004', institution: 'Northwind Investments', type: 'INVESTMENT', balance: ira },
    { key: 'rollover', name: 'Rollover IRA ...0008', institution: 'Northwind Investments', type: 'INVESTMENT', balance: rollover },
    { key: 'loan', name: 'Student Loan ...0005', institution: 'Bluestone Loan Servicing', type: 'LOAN', balance: round2(-41400 + sumOf('loan')) },
  ];
  // Every other account gets month-end snapshots too, as a live feed writes
  // them: without one, a card's and a loan's history is only "estimated".
  for (const key of ['checking', 'savings', 'card', 'fuelcard', 'loan']) {
    const account = accounts.find((a) => a.key === key)!;
    for (const mo of months.filter((m) => !m.current)) {
      const end = new Date(Date.UTC(mo.y, mo.m0 + 1, 0, 23, 59, 59));
      const after = txns.filter((t) => t.accountKey === key && t.date.getTime() > end.getTime()).reduce((s, t) => s + t.amount, 0);
      snapshots.push({ accountKey: key, date: end, balance: round2(account.balance - after) });
    }
    snapshots.push({ accountKey: key, date: today, balance: account.balance });
  }

  // The live feed's recent weeks: one balance per account per bank day,
  // stamped at a 4pm Eastern close, so Trends' net worth zooms into days
  // (ui/dailyNetWorth.ts). A bank account steps back from today through its
  // transactions; an investment runs between its month-ends with a small daily
  // wobble, as a market does.
  const DEMO_DAILY_DAYS = 90;
  const investments = new Set(['brokerage', 'ira', 'rollover']);
  for (let k = DEMO_DAILY_DAYS; k >= 1; k--) {
    const dayStart = Date.UTC(cy, cm, today.getUTCDate() - k);
    const dayEnd = dayStart + 86_400_000;
    const stamp = new Date(dayStart + 20 * 3_600_000);
    for (const account of accounts) {
      if (!investments.has(account.key)) {
        const after = txns.filter((t) => t.accountKey === account.key && t.date.getTime() >= dayEnd).reduce((s, t) => s + t.amount, 0);
        snapshots.push({ accountKey: account.key, date: stamp, balance: round2(account.balance - after) });
        continue;
      }
      const own = snapshots.filter((s) => s.accountKey === account.key).sort((a, b) => a.date.getTime() - b.date.getTime());
      const before = own.filter((s) => s.date.getTime() <= stamp.getTime()).at(-1);
      const next = own.find((s) => s.date.getTime() > stamp.getTime());
      if (before === undefined || next === undefined) continue;
      const share = (stamp.getTime() - before.date.getTime()) / (next.date.getTime() - before.date.getTime());
      const wobble = 1 + (rand() - 0.5) * 0.008;
      snapshots.push({ accountKey: account.key, date: stamp, balance: round2((before.balance + (next.balance - before.balance) * share) * wobble) });
    }
  }

  // Ten months out: the demo's fund lands later than that at its saving pace, so the
  // goal card shows its BEHIND alert (a screen feature the demo must be able to show).
  const houseTargetMonth = new Date(Date.UTC(cy, cm + 10, 1));
  return {
    now,
    categories: [
      { name: 'Income', isIncome: true },
      ...['Rent & Housing', 'Groceries', 'Dining', 'Coffee', 'Utilities', 'Subscriptions', 'Gas', 'Transport', 'Shopping', 'Health', 'Entertainment', 'Travel', 'Gifts'].map(
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
          { id: 'house-deposit', name: 'House deposit', target: 149500, housePrice: 650000, targetMonth: monthKey(houseTargetMonth.getUTCFullYear(), houseTargetMonth.getUTCMonth()), cash: true, accountIds: [] },
        ],
      },
      // The net worth goal, with a typed return so both dates show.
      { key: 'goals.netWorth', value: { target: 1000000, realReturnPct: 5, returnSetOn: isoDay(new Date(today.getTime() - 6 * DAY_MS)) } },
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
  // Self-references after every row exists, a few hundred rows per statement:
  // on Turso the COUNT of round trips is the cost, and eleven years of
  // transfers, written one row at a time, was over a thousand of them inside
  // the nightly reset's sixty seconds.
  const links = plan.txns.filter((t) => t.pairWith !== undefined || t.reimburses !== undefined);
  for (let i = 0; i < links.length; i += LINKS_PER_STATEMENT) {
    const chunk = links.slice(i, i + LINKS_PER_STATEMENT);
    const caseOf = (column: string, pick: (t: DemoTxn) => string | undefined) => {
      const rows = chunk.filter((t) => pick(t) !== undefined);
      return rows.length === 0
        ? { sql: `"${column}"`, params: [] as string[] }
        : {
            sql: `CASE "id" ${rows.map(() => 'WHEN ? THEN ?').join(' ')} ELSE "${column}" END`,
            params: rows.flatMap((t) => [t.id, pick(t)!]),
          };
    };
    const pairs = caseOf('transferPairId', (t) => t.pairWith);
    const repaid = caseOf('reimbursesId', (t) => t.reimburses);
    await prisma.$executeRawUnsafe(
      `UPDATE "Transaction" SET "transferPairId" = ${pairs.sql}, "reimbursesId" = ${repaid.sql} WHERE "id" IN (${chunk.map(() => '?').join(', ')})`,
      ...pairs.params,
      ...repaid.params,
      ...chunk.map((t) => t.id),
    );
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
