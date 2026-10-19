import { describe, expect, it } from 'vitest';
import {
  assessGoals,
  extraToLand,
  monthsAfterTarget,
  parseGoals,
  projectLanding,
  SHORTFALL_STEP,
  withGoalPace,
  type GoalAccount,
  type SavingsGoal,
} from './goals';

/** Invented figures throughout. The savings card's "Saved per month" and its BEHIND alert (enhancement E2). */
const NOW = new Date(Date.UTC(2026, 6, 31, 12, 0, 0));
const NOW_MS = NOW.getTime();
// Six complete months whose mean is exactly 2,000/mo.
const NETS = [2000, 1000, 3000, 2000, 1000, 3000];

const goal = (over: Partial<SavingsGoal> = {}): SavingsGoal => ({
  id: 'house-deposit',
  name: 'House deposit',
  target: 60_000,
  targetMonth: '2027-06',
  accountIds: ['sav'],
  ...over,
});
const accounts: GoalAccount[] = [{ id: 'sav', name: 'Savings', balance: 24_000 }];

const assess = (g: SavingsGoal, nets: number[] = NETS) =>
  assessGoals({ goals: [g], accounts, completeMonthlyNet: nets, now: NOW })[0];

describe('extraToLand (the shortfall solver)', () => {
  it('asks for the extra that lands in the target month when the goal is behind', () => {
    const a = assess(goal());
    expect(a.deltaMonths).toBeGreaterThan(0); // 36,000 left at 2,000/mo lands January 2028, 7 months late
    const ask = extraToLand({ remaining: a.remaining, rate: a.monthlyRate, targetMonth: '2027-06', nowMs: NOW_MS });
    expect(ask).not.toBeNull();
    expect(ask!.extra % SHORTFALL_STEP).toBe(0);
    // Saving the printed extra on top of the pace really lands on time ...
    const on = projectLanding(a.remaining, a.monthlyRate! + ask!.extra, NOW_MS)!;
    expect(monthsAfterTarget(on.landsMonth, '2027-06')).toBeLessThanOrEqual(0);
    // ... and one rounding step less does not: the figure is the smallest $10 step that works.
    const short = projectLanding(a.remaining, a.monthlyRate! + ask!.extra - SHORTFALL_STEP, NOW_MS)!;
    expect(monthsAfterTarget(short.landsMonth, '2027-06')).toBeGreaterThan(0);
  });

  it('agrees with the card arithmetic the server ran, never a second formula', () => {
    const a = assess(goal());
    const again = projectLanding(a.remaining, a.monthlyRate!, NOW_MS)!;
    expect(again.landsMonth).toBe(a.landsMonth);
    expect(again.monthsToTarget).toBe(a.monthsToTarget);
  });

  it('asks for nothing when the goal is on track or ahead', () => {
    const onTrack = assess(goal({ targetMonth: '2028-01' }));
    expect(onTrack.deltaMonths).toBe(0);
    expect(extraToLand({ remaining: onTrack.remaining, rate: onTrack.monthlyRate, targetMonth: '2028-01', nowMs: NOW_MS })).toBeNull();
    const ahead = assess(goal({ targetMonth: '2030-01' }));
    expect(ahead.deltaMonths).toBeLessThan(0);
    expect(extraToLand({ remaining: ahead.remaining, rate: ahead.monthlyRate, targetMonth: '2030-01', nowMs: NOW_MS })).toBeNull();
  });

  it('asks for nothing without a target month', () => {
    const a = assess(goal({ targetMonth: undefined }));
    expect(a.landsMonth).not.toBeNull();
    expect(extraToLand({ remaining: a.remaining, rate: a.monthlyRate, targetMonth: undefined, nowMs: NOW_MS })).toBeNull();
  });

  it('asks for nothing with no pace to build on', () => {
    for (const rate of [0, -500, null]) {
      expect(extraToLand({ remaining: 36_000, rate, targetMonth: '2027-06', nowMs: NOW_MS })).toBeNull();
    }
    const stalled = assess(goal(), [-500, -500, -500, -500, -500, -500]);
    expect(stalled.refusal).toBe('RATE_NOT_POSITIVE');
  });

  it('asks for nothing once the target month is over, or nothing is left to save', () => {
    expect(extraToLand({ remaining: 36_000, rate: 2000, targetMonth: '2026-07', nowMs: NOW_MS })).toBeNull();
    expect(extraToLand({ remaining: 0, rate: 2000, targetMonth: '2027-06', nowMs: NOW_MS })).toBeNull();
  });
});

describe('the set pace (goals.savings monthlyPace)', () => {
  const stored = JSON.stringify([goal(), goal({ id: 'car', name: 'Car', target: 9_000, targetMonth: undefined })]);

  it('writes one goal, clears it, and leaves every other entry and field as read', () => {
    const set = withGoalPace(stored, 'house-deposit', 3300);
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const [house, car] = JSON.parse(set.value);
    expect(house.monthlyPace).toBe(3300);
    expect(house).toMatchObject({ id: 'house-deposit', target: 60_000, targetMonth: '2027-06' });
    expect(car).toEqual(JSON.parse(stored)[1]);

    const cleared = withGoalPace(set.value, 'house-deposit', null);
    expect(cleared.ok && cleared.value).toBe(stored);
  });

  it('round-trips through parseGoals into the projection', () => {
    const set = withGoalPace(stored, 'house-deposit', 3300);
    if (!set.ok) throw new Error('save refused');
    const [house] = parseGoals(set.value);
    expect(house.monthlyPace).toBe(3300);
    const a = assess(house);
    expect(a.paceSet).toBe(3300);
    expect(a.monthlyRate).toBe(3300); // the landing follows the set pace ...
    expect(a.measuredRate).toBe(2000); // ... while the measured figure stays on offer
    expect(a.landsMonth).toBe(projectLanding(36_000, 3300, NOW_MS)!.landsMonth);
  });

  it('keeps the landing on the measured pace for every entry written before the field existed', () => {
    const [old] = parseGoals(stored);
    expect(old.monthlyPace).toBeUndefined();
    const a = assess(old);
    expect(a.paceSet).toBeNull();
    expect(a.monthlyRate).toBe(2000);
    expect(a.measuredRate).toBe(2000);
  });

  it('keeps the goal and ignores a pace it cannot read', () => {
    const raw = JSON.stringify([{ ...goal(), monthlyPace: 'lots' }, { ...goal({ id: 'b' }), monthlyPace: null }]);
    const parsed = parseGoals(raw);
    expect(parsed.map((g) => g.id)).toEqual(['house-deposit', 'b']);
    expect(parsed.every((g) => g.monthlyPace === undefined)).toBe(true);
  });

  it('refuses rather than overwrite what it cannot read, or a goal that is gone', () => {
    expect(withGoalPace(null, 'house-deposit', 1000).ok).toBe(false);
    expect(withGoalPace('not json', 'house-deposit', 1000).ok).toBe(false);
    expect(withGoalPace(stored, 'no-such-goal', 1000).ok).toBe(false);
    expect(withGoalPace(stored, 'house-deposit', Number.NaN).ok).toBe(false);
  });

  it('writes back an entry a newer shape added to, or one this build cannot read, untouched', () => {
    const raw = JSON.stringify([{ ...goal(), future: { a: 1 } }, { id: 'broken' }]);
    const set = withGoalPace(raw, 'house-deposit', 2500);
    if (!set.ok) throw new Error('save refused');
    const [house, broken] = JSON.parse(set.value);
    expect(house.future).toEqual({ a: 1 });
    expect(broken).toEqual({ id: 'broken' });
  });
});
