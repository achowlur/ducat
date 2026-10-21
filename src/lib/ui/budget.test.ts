import { describe, expect, it } from 'vitest';
import type { CategorySpending, SpendingByCategoryPayload } from '../../types/contracts';
import { buildBudget, parseBudget, typicalShare, withBudgetEdit } from './budget';

// Invented figures throughout.
const cat = (categoryId: string | null, categoryName: string | null, spending: number, byDay?: [number, number][]): CategorySpending => ({
  categoryId,
  categoryName,
  spending,
  previousSpending: null,
  deltaPct: null,
  ...(byDay ? { byDay } : {}),
});

const month = (period: string, categories: CategorySpending[]) => ({
  period,
  payload: {
    granularity: 'MONTH',
    totalSpending: categories.reduce((s, c) => s + c.spending, 0),
    previousTotalSpending: null,
    categories,
  } satisfies SpendingByCategoryPayload,
});

const NOW = new Date(Date.UTC(2026, 9, 15, 12)); // 15 October 2026
const covered = [new Date(Date.UTC(2024, 0, 1))];

/** Twelve complete months before October 2026, each built by `f`. */
const history = (f: (period: string, i: number) => CategorySpending[]) =>
  Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 9 + i, 1));
    const period = d.toISOString().slice(0, 7);
    return month(period, f(period, i));
  });

describe('buildBudget', () => {
  it('suggests a monthly limit from the middle of the last six comparable months, rounded up to $10', () => {
    const months = [
      ...history((_, i) => [cat('g', 'Groceries', [400, 410, 420, 430, 440, 450, 300, 305, 310, 315, 320, 900][i])]),
      month('2026-10', [cat('g', 'Groceries', 100)]),
    ];
    const b = buildBudget({ now: NOW, months, firstTransactions: covered, choices: {}, income: null });
    const g = b.monthly.find((l) => l.key === 'g')!;
    // Apr-Sep: 300 305 310 315 320 900 → middle 312.5 → $320.
    expect(g.suggested).toBe(320);
    expect(g.limit).toBe(320);
    expect(g.spent).toBe(100);
    expect(b.left).toBe(220);
    expect(b.daysLeft).toBe(17);
    expect(b.perDay).toBeCloseTo(220 / 17, 2);
  });

  it('a typed limit replaces the suggestion', () => {
    const months = [...history(() => [cat('g', 'Groceries', 300)]), month('2026-10', [cat('g', 'Groceries', 50)])];
    const b = buildBudget({ now: NOW, months, firstTransactions: covered, choices: { g: { limit: 250 } }, income: null });
    expect(b.monthly[0]).toMatchObject({ limit: 250, suggested: 300, typed: true });
  });

  it('budgets travel and rarely spent categories yearly, over the calendar year, outside the headline', () => {
    const months = [
      ...history((period) => [
        cat('g', 'Groceries', 300),
        ...(period === '2026-03' ? [cat('t', 'Travel', 1200)] : []),
        ...(period === '2025-12' || period === '2026-05' ? [cat('x', 'Gifts', 300)] : []),
      ]),
      month('2026-10', [cat('g', 'Groceries', 50), cat('x', 'Gifts', 40)]),
    ];
    const b = buildBudget({ now: NOW, months, firstTransactions: covered, choices: {}, income: 5000 });
    expect(b.monthly.map((l) => l.key)).toEqual(['g']);
    const travel = b.yearly.find((l) => l.key === 't')!;
    const gifts = b.yearly.find((l) => l.key === 'x')!;
    expect(travel).toMatchObject({ yearlyByDefault: true, suggested: 1200, spent: 1200, status: 'on-pace' });
    // This year's only: December 2025 is last year.
    expect(gifts).toMatchObject({ suggested: 600, spent: 340, spentThisMonth: 40 });
    expect(b.yearlySetAside).toBe(150);
    // Income less monthly limits (300) less the yearly twelfth (150).
    expect(b.toSave).toBe(4550);
    expect(b.left).toBe(250);
  });

  it('flags over and ahead of pace; yearly lines are never "ahead"', () => {
    const months = [
      ...history(() => [cat('g', 'Groceries', 300), cat('d', 'Dining', 200), cat('t', 'Travel', 100)]),
      // Travel this year: 9 × 100 + 100 = 1000 of 1200, past a straight line (~950) yet never "ahead".
      month('2026-10', [cat('g', 'Groceries', 320), cat('d', 'Dining', 180), cat('t', 'Travel', 100)]),
    ];
    const b = buildBudget({ now: NOW, months, firstTransactions: covered, choices: {}, income: null });
    expect(b.monthly.find((l) => l.key === 'g')!.status).toBe('over');
    // Straight line without a day-by-day record: 200 × 15/31 ≈ 96.77, ahead.
    expect(b.monthly.find((l) => l.key === 'd')).toMatchObject({ status: 'ahead', paceFromHistory: false });
    expect(b.yearly.find((l) => l.key === 't')!.status).toBe('on-pace');
  });

  it('paces a category paid early in the month by its own timing', () => {
    const months = [
      ...history(() => [cat('r', 'Rent & Housing', 2000, [[1, 2000]])]),
      month('2026-10', [cat('r', 'Rent & Housing', 2000, [[1, 2000]])]),
    ];
    const b = buildBudget({ now: NOW, months, firstTransactions: covered, choices: {}, income: null });
    expect(b.monthly[0]).toMatchObject({ expectedByToday: 2000, paceFromHistory: true, status: 'on-pace' });
  });

  it('leaves out a category gone quiet and suggests from comparable months only', () => {
    const months = [
      ...history((period) => (period < '2026-04' ? [cat('o', 'Old', 50)] : [cat('g', 'Groceries', 300)])),
      month('2026-10', [cat('g', 'Groceries', 10)]),
    ];
    // Records of a second account begin in May 2026: April and earlier are not comparable.
    const b = buildBudget({
      now: NOW,
      months,
      firstTransactions: [covered[0], new Date(Date.UTC(2026, 4, 1))],
      choices: {},
      income: null,
    });
    expect(b.window.used).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    expect(b.monthly.map((l) => l.key)).toEqual(['g']);
  });

  it('names the ten largest monthly budgets and folds the rest into one line that adds them up', () => {
    const names = Array.from({ length: 12 }, (_, i) => `C${i}`);
    const months = [
      ...history(() => names.map((n, i) => cat(n, n, 100 + i * 10))),
      // New this month, no history: a $0 limit, folded rather than "over".
      month('2026-10', [cat('new', 'New', 25), ...names.map((n) => cat(n, n, 10))]),
    ];
    const b = buildBudget({ now: NOW, months, firstTransactions: covered, choices: {}, income: null });
    expect(b.monthly).toHaveLength(10);
    expect(b.monthly.slice(0, 9).map((l) => l.key)).toEqual(['C11', 'C10', 'C9', 'C8', 'C7', 'C6', 'C5', 'C4', 'C3']);
    const other = b.monthly[9];
    expect(other).toMatchObject({ name: 'Other · 4', limit: 100 + 110 + 120, spent: 55, folded: ['C2', 'C1', 'C0', 'New'] });
    expect(b.monthlyLimit).toBe(names.reduce((s, _, i) => s + 100 + i * 10, 0));
  });

  it('survives no history at all', () => {
    const b = buildBudget({ now: NOW, months: [], firstTransactions: [], choices: {}, income: null });
    expect(b).toMatchObject({ monthly: [], yearly: [], left: 0, perDay: null, toSave: null });
  });
});

describe('typicalShare', () => {
  it('is the middle of the months\' shares by that day, and refuses under three months', () => {
    const rows = [
      month('2026-07', [cat('g', 'G', 100, [[5, 50], [20, 50]])]),
      month('2026-08', [cat('g', 'G', 100, [[10, 20], [25, 80]])]),
      month('2026-09', [cat('g', 'G', 100, [[3, 70], [28, 30]])]),
    ];
    expect(typicalShare(rows, 'g', 15)).toBe(0.5);
    expect(typicalShare(rows.slice(0, 2), 'g', 15)).toBeNull();
  });
});

describe('budget choices', () => {
  it('parses what it can and ignores the rest', () => {
    expect(parseBudget('{"a":{"limit":100},"b":{"yearly":true},"c":{"limit":-5},"d":3}')).toEqual({
      a: { limit: 100 },
      b: { yearly: true },
    });
    expect(parseBudget('nope')).toEqual({});
  });

  it('clears a limit back to the suggestion, and drops it when switching unit', () => {
    let r = withBudgetEdit({}, { kind: 'limit', key: 'g', limit: 250 });
    expect(r).toEqual({ ok: true, choices: { g: { limit: 250 } } });
    r = withBudgetEdit({ g: { limit: 250 } }, { kind: 'yearly', key: 'g', yearly: true, yearlyByDefault: false });
    expect(r).toEqual({ ok: true, choices: { g: { yearly: true } } });
    r = withBudgetEdit({ g: { yearly: true } }, { kind: 'yearly', key: 'g', yearly: false, yearlyByDefault: false });
    expect(r).toEqual({ ok: true, choices: {} });
    expect(withBudgetEdit({}, { kind: 'limit', key: 'g', limit: -1 }).ok).toBe(false);
  });
});
