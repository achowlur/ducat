import { describe, expect, it } from 'vitest';
import { RUNWAY_MIN_MONTHS, RUNWAY_MONTHS } from '../ui/liquidity';
import {
  assessGoals,
  GOAL_RATE_MIN_MONTHS,
  GOAL_RATE_MONTHS,
  parseGoals,
  type GoalAccount,
  type SavingsGoal,
} from './goals';

const goal = (over: Partial<SavingsGoal> = {}): SavingsGoal => ({
  id: 'house-deposit',
  name: 'House deposit',
  target: 60_000,
  targetMonth: '2028-06',
  accountIds: ['sav'],
  ...over,
});

const accounts: GoalAccount[] = [
  { id: 'sav', name: 'Platinum Savings', balance: 10_000 },
  { id: 'mm', name: 'Money Market', balance: 14_000 },
];

/** now for every projection test: last day of a month, mid-day, like real use. */
const NOW = new Date(Date.UTC(2026, 6, 31, 12, 0, 0));

// Six complete months whose mean is exactly 2,000/mo.
const NETS = [2000, 1000, 3000, 2000, 1000, 3000];

describe('rate window parity', () => {
  // One notion of "recent complete months" on the app. If these drift apart,
  // the runway and the goal panel silently average different windows.
  it('uses the same window computeRunway averages over', () => {
    expect(GOAL_RATE_MONTHS).toBe(RUNWAY_MONTHS);
    expect(GOAL_RATE_MIN_MONTHS).toBe(RUNWAY_MIN_MONTHS);
  });
});

describe('parseGoals', () => {
  it('parses a declared goal', () => {
    const g = parseGoals(JSON.stringify([goal()]));
    expect(g).toHaveLength(1);
    expect(g[0].name).toBe('House deposit');
  });

  it('survives corruption rather than taking the page down', () => {
    expect(parseGoals(null)).toEqual([]);
    expect(parseGoals('not json')).toEqual([]);
    expect(parseGoals('{"a":1}')).toEqual([]);
  });

  it('drops malformed entries and keeps the valid ones', () => {
    const raw = JSON.stringify([
      goal(),
      { ...goal({ id: 'no-target' }), target: undefined },
      goal({ id: 'bad-month', targetMonth: '2028-13' }),
      goal({ id: 'free', target: 0 }),
      goal({ id: 'nameless', name: '' }),
    ]);
    expect(parseGoals(raw).map((g) => g.id)).toEqual(['house-deposit']);
  });

  it('tolerates an empty account list — that refusal belongs to assessment', () => {
    expect(parseGoals(JSON.stringify([goal({ accountIds: [] })]))).toHaveLength(1);
  });

  // 2026-08-01: targetMonth became optional (the landing date is always
  // projected; --by is only the aspiration) and cash goals were added. Both
  // shapes must round-trip parseGoals, and the OLD shape must keep parsing —
  // during a deploy the database can hold either.
  it('accepts a goal with no targetMonth', () => {
    const raw = JSON.stringify([{ ...goal(), targetMonth: undefined }]);
    const g = parseGoals(raw);
    expect(g).toHaveLength(1);
    expect(g[0].targetMonth).toBeUndefined();
  });

  it('keeps a declared house price and drops a malformed one', () => {
    const kept = parseGoals(JSON.stringify([goal({ housePrice: 500_000 })]));
    expect(kept[0].housePrice).toBe(500_000);
    // A non-positive price is malformed config, dropped like any other.
    expect(parseGoals(JSON.stringify([goal({ housePrice: -1 })]))).toHaveLength(0);
    // Absent stays absent — the field is a declared aspiration, never derived.
    expect(parseGoals(JSON.stringify([goal()]))[0].housePrice).toBeUndefined();
  });

  it('accepts a cash goal with an empty nomination', () => {
    const g = parseGoals(JSON.stringify([goal({ cash: true, accountIds: [] })]));
    expect(g).toHaveLength(1);
    expect(g[0].cash).toBe(true);
  });

  it('still drops a malformed targetMonth when one is present', () => {
    expect(parseGoals(JSON.stringify([goal({ targetMonth: 'June 2028' })]))).toHaveLength(0);
  });

  it('drops a non-boolean cash flag rather than guessing at it', () => {
    const raw = JSON.stringify([{ ...goal(), cash: 'yes' }]);
    expect(parseGoals(raw)).toHaveLength(0);
  });
});

describe('assessGoals', () => {
  it('sums nominated balances and projects a landing month at the mean rate', () => {
    const [a] = assessGoals({
      goals: [goal({ accountIds: ['sav', 'mm'] })],
      accounts,
      completeMonthlyNet: NETS,
      now: NOW,
    });
    expect(a.saved).toBe(24_000);
    expect(a.accountNames).toEqual(['Platinum Savings', 'Money Market']);
    expect(a.remaining).toBe(36_000);
    expect(a.progress).toBe(0.4);
    expect(a.monthlyRate).toBe(2000);
    expect(a.basisMonths).toBe(6);
    expect(a.rateLow).toBe(1000);
    expect(a.rateHigh).toBe(3000);
    // 36,000 / 2,000 = 18 months from Jul 31 2026 → late Jan 2028.
    expect(a.monthsToTarget).toBe(18);
    expect(a.landsMonth).toBe('2028-01');
    // Five months ahead of a Jun 2028 target.
    expect(a.deltaMonths).toBe(-5);
    expect(a.refusal).toBeNull();
  });

  it('averages only the last six complete months', () => {
    const [a] = assessGoals({
      goals: [goal({ accountIds: ['sav', 'mm'] })],
      accounts,
      completeMonthlyNet: [99_999, -99_999, 1000, 1000, 1000, 1000, 1000, 1000],
      now: NOW,
    });
    expect(a.monthlyRate).toBe(1000);
    expect(a.rateHigh).toBe(1000);
  });

  it('rounds the month count to one decimal, like runway months', () => {
    const [a] = assessGoals({
      goals: [goal({ target: 27_500 })], // saved 10,000 → remaining 17,500
      accounts,
      completeMonthlyNet: [3000, 3000, 3000],
      now: NOW,
    });
    expect(a.monthsToTarget).toBe(5.8); // 17,500 / 3,000 = 5.8333…
  });

  it('lands across a year boundary correctly', () => {
    const [a] = assessGoals({
      goals: [goal({ target: 13_000, targetMonth: '2027-01' })], // remaining 3,000
      accounts,
      completeMonthlyNet: [1000, 1000, 1000],
      now: new Date(Date.UTC(2026, 10, 15)),
    });
    expect(a.landsMonth).toBe('2027-02');
    expect(a.deltaMonths).toBe(1); // one month behind the Jan target
  });

  // Refusals: each would otherwise print a date that means nothing. The facts
  // either side of the projection survive every one of them.
  it('refuses with too few complete months, still reporting what is saved', () => {
    const [a] = assessGoals({
      goals: [goal()],
      accounts,
      completeMonthlyNet: [2000, 2000],
      now: NOW,
    });
    expect(a.refusal).toBe('TOO_FEW_MONTHS');
    expect(a.saved).toBe(10_000);
    expect(a.basisMonths).toBe(2);
    expect(a.monthlyRate).toBeNull();
    expect(a.landsMonth).toBeNull();
  });

  it('projects from exactly the minimum months, like computeRunway', () => {
    const [a] = assessGoals({
      goals: [goal()],
      accounts,
      completeMonthlyNet: [2000, 2000, 2000],
      now: NOW,
    });
    expect(a.refusal).toBeNull();
    expect(a.landsMonth).not.toBeNull();
  });

  it('refuses a rate at or below zero, showing the rate that refused', () => {
    const [zero] = assessGoals({
      goals: [goal()],
      accounts,
      completeMonthlyNet: [0, 0, 0],
      now: NOW,
    });
    expect(zero.refusal).toBe('RATE_NOT_POSITIVE');

    const [neg] = assessGoals({
      goals: [goal()],
      accounts,
      completeMonthlyNet: [-500, -100, -300],
      now: NOW,
    });
    expect(neg.refusal).toBe('RATE_NOT_POSITIVE');
    // The observed rate is a fact and the reason there is no date — shown.
    expect(neg.monthlyRate).toBe(-300);
    expect(neg.rateLow).toBe(-500);
    expect(neg.rateHigh).toBe(-100);
    expect(neg.landsMonth).toBeNull();
  });

  it('reports a reached goal as reached, even over a bad stretch', () => {
    const [a] = assessGoals({
      goals: [goal({ target: 9_000 })],
      accounts,
      completeMonthlyNet: [-500, -500, -500],
      now: NOW,
    });
    expect(a.reached).toBe(true);
    expect(a.refusal).toBeNull();
    expect(a.remaining).toBe(-1_000); // overshoot stays visible, signed
    expect(a.progress).toBe(1);
    expect(a.landsMonth).toBeNull();
  });

  it('treats a goal whose accounts are all gone as broken config, not $0 saved', () => {
    const [a] = assessGoals({
      goals: [goal({ accountIds: ['deleted', 'also-gone'] })],
      accounts,
      completeMonthlyNet: NETS,
      now: NOW,
    });
    expect(a.refusal).toBe('NO_ACCOUNTS');
    expect(a.missingAccounts).toBe(2);
    expect(a.landsMonth).toBeNull();
  });

  it('counts a partly-missing nomination and keeps projecting from what resolves', () => {
    const [a] = assessGoals({
      goals: [goal({ accountIds: ['sav', 'deleted'] })],
      accounts,
      completeMonthlyNet: NETS,
      now: NOW,
    });
    expect(a.missingAccounts).toBe(1);
    expect(a.saved).toBe(10_000);
    expect(a.refusal).toBeNull();
    expect(a.landsMonth).not.toBeNull();
  });

  it('clamps progress for an overdrawn fund without hiding the arithmetic', () => {
    const [a] = assessGoals({
      goals: [goal({ accountIds: ['odft'] })],
      accounts: [{ id: 'odft', name: 'Overdrawn', balance: -200 }],
      completeMonthlyNet: [1000, 1000, 1000],
      now: NOW,
    });
    expect(a.progress).toBe(0);
    expect(a.saved).toBe(-200);
    expect(a.remaining).toBe(60_200);
  });

  it('draws a cash goal from the cash definition, ignoring accountIds entirely', () => {
    const [a] = assessGoals({
      goals: [goal({ cash: true, accountIds: ['deleted', 'irrelevant'] })],
      accounts,
      cashAccounts: [
        { id: 'chk', name: 'Checking', balance: 16_000 },
        { id: 'mm', name: 'Money Market', balance: 14_000 },
      ],
      completeMonthlyNet: NETS,
      now: NOW,
    });
    expect(a.saved).toBe(30_000);
    expect(a.accountNames).toEqual(['Checking', 'Money Market']);
    // A definition cannot have missing ids — that failure mode belongs to
    // nominated goals only.
    expect(a.missingAccounts).toBe(0);
    expect(a.refusal).toBeNull();
  });

  it('refuses a cash goal when nothing counts as cash', () => {
    const [a] = assessGoals({
      goals: [goal({ cash: true, accountIds: [] })],
      accounts,
      cashAccounts: [],
      completeMonthlyNet: NETS,
      now: NOW,
    });
    expect(a.refusal).toBe('NO_ACCOUNTS');
  });

  it('projects a landing date with no declared month, and refuses the comparison', () => {
    const [a] = assessGoals({
      goals: [goal({ targetMonth: undefined, accountIds: ['sav', 'mm'] })],
      accounts,
      completeMonthlyNet: NETS,
      now: NOW,
    });
    // 36,000 / 2,000 = 18 months — the projection is Ducat's own date...
    expect(a.landsMonth).toBe('2028-01');
    // ...and with no aspiration declared there is no ahead/behind to invent.
    expect(a.deltaMonths).toBeNull();
    expect(a.refusal).toBeNull();
  });

  it('carries observed cash growth onto cash goals only — the reconciliation line', () => {
    const out = assessGoals({
      goals: [goal({ id: 'cash-goal', cash: true, accountIds: [] }), goal({ id: 'nominated' })],
      accounts,
      cashAccounts: [{ id: 'chk', name: 'Checking', balance: 16_000 }],
      observedCashGrowth: 3285.686,
      completeMonthlyNet: NETS,
      now: NOW,
    });
    expect(out[0].observedFundGrowth).toBe(3285.69); // rounded like every money figure
    // A nominated fund can hold investment accounts, whose balances
    // transactions cannot explain — no number is honest there.
    expect(out[1].observedFundGrowth).toBeNull();
  });

  it('omits the reconciliation when the caller could not compute it', () => {
    const [a] = assessGoals({
      goals: [goal({ cash: true, accountIds: [] })],
      accounts,
      cashAccounts: [{ id: 'chk', name: 'Checking', balance: 16_000 }],
      completeMonthlyNet: NETS,
      now: NOW,
    });
    expect(a.observedFundGrowth).toBeNull();
  });

  it('assesses every goal against the one shared rate, in declaration order', () => {
    const out = assessGoals({
      goals: [goal(), goal({ id: 'car', name: 'Car', target: 20_000, accountIds: ['mm'] })],
      accounts,
      completeMonthlyNet: NETS,
      now: NOW,
    });
    expect(out.map((a) => a.goal.id)).toEqual(['house-deposit', 'car']);
    expect(out[0].monthlyRate).toBe(2000);
    expect(out[1].monthlyRate).toBe(2000);
  });
});
