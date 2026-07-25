import { describe, expect, it } from 'vitest';
import { suggestReimbursements, type SuggestOutflow } from './suggestReimbursements';

const day = (d: number) => new Date(Date.UTC(2026, 6, d, 12));
const out = (id: string, amount: number, d: number): SuggestOutflow => ({ id, amount: -amount, date: day(d) });

describe('suggestReimbursements', () => {
  // The whole point: a big expense that happens to be closer in time must not
  // outrank the expense whose amount actually matches.
  it('ranks an exact amount match above a nearer but unrelated large expense', () => {
    const results = suggestReimbursements({ amount: 45, date: day(20) }, [
      out('rent', 2000, 19), // 1 day before, amount unrelated
      out('dinner', 45, 10), // 10 days before, exact
    ]);
    expect(results[0].id).toBe('dinner');
    expect(results[0].reason).toBe('exact amount');
  });

  it('recognises a clean split of a shared bill', () => {
    const [top] = suggestReimbursements({ amount: 30, date: day(12) }, [out('bill', 90, 10)]);
    expect(top.reason).toBe('1/3 of $90.00');
  });

  it('tolerates the rounding of an odd total across a split', () => {
    // $90.01 split three ways: someone pays $77.75, someone $30.01.
    const [top] = suggestReimbursements({ amount: 30, date: day(12) }, [out('bill', 90.01, 10)]);
    expect(top.reason).toBe('1/3 of $90.01');
  });

  // Real case from live data: a $118.75 bill five ways is $61.55 each, and the
  // friend sent $62.20. Cent-exact split matching misses every rounded share.
  it('recognises a rounded share, and marks it approximate', () => {
    const [top] = suggestReimbursements({ amount: 24, date: day(23) }, [out('dinner', 118.75, 21)]);
    expect(top.reason).toBe('≈1/5 of $118.75');
    expect(top.strong).toBe(true);
  });

  it('does not stretch rounding into unrelated amounts', () => {
    // $62.2 against an $89.05 Amazon order is no split of anything.
    const [top] = suggestReimbursements({ amount: 24, date: day(23) }, [out('amazon', 89.05, 22)]);
    expect(top.reason).toBe('part of $89.05');
    expect(top.strong).toBe(false);
  });

  // Arithmetic can't tell a split dinner from a divisible tax bill; only the
  // category can. Without this the ranker confidently offers "1/6 of $6,300.49".
  it('refuses to treat an unsplittable expense as a split', () => {
    const [top] = suggestReimbursements({ amount: 400, date: day(20) }, [
      { id: 'tax', amount: -2400, date: day(18), splittable: false },
    ]);
    expect(top.reason).toBe('part of $2400.00');
    expect(top.strong).toBe(false);
  });

  it('still allows repaying an unsplittable expense in full', () => {
    const [top] = suggestReimbursements({ amount: 1750, date: day(20) }, [
      { id: 'rent', amount: -1750, date: day(18), splittable: false },
    ]);
    expect(top).toMatchObject({ reason: 'exact amount', strong: true });
  });

  it('prefers an exact split over a rounded one', () => {
    const results = suggestReimbursements({ amount: 24, date: day(23) }, [
      out('rounded', 118.75, 22),
      out('exactsplit', 96, 22),
    ]);
    expect(results[0].id).toBe('exactsplit');
  });

  it('never suggests an expense smaller than the repayment', () => {
    expect(suggestReimbursements({ amount: 100, date: day(12) }, [out('small', 40, 10)])).toEqual([]);
  });

  it('ignores outflows outside the window, including ones after the inflow', () => {
    const results = suggestReimbursements({ amount: 50, date: day(20) }, [
      out('ancient', 50, -40), // ~60 days earlier
      out('later', 50, 27), // a week AFTER the inflow
    ]);
    expect(results).toEqual([]);
  });

  it('allows a few days of lead but scores it below the same match trailing', () => {
    const lead = suggestReimbursements({ amount: 50, date: day(10) }, [out('x', 50, 12)]);
    const trail = suggestReimbursements({ amount: 50, date: day(14) }, [out('x', 50, 12)]);
    expect(lead).toHaveLength(1);
    expect(trail[0].score).toBeGreaterThan(lead[0].score);
  });

  it('prefers the closer of two identical amount matches', () => {
    const results = suggestReimbursements({ amount: 25, date: day(20) }, [
      out('far', 25, 5),
      out('near', 25, 18),
    ]);
    expect(results[0].id).toBe('near');
  });

  // `strong` must track amount evidence alone: an exact repayment three weeks
  // later is still conclusive, while a same-day partial is just a coincidence.
  it('marks conclusive amount evidence strong regardless of elapsed time', () => {
    const [late] = suggestReimbursements({ amount: 50, date: day(28) }, [out('exact', 50, 7)]);
    expect(late.strong).toBe(true);
    const [sameDay] = suggestReimbursements({ amount: 50, date: day(10) }, [out('partial', 137.5, 10)]);
    expect(sameDay.strong).toBe(false);
  });

  it('caps how many suggestions it returns', () => {
    const many = Array.from({ length: 12 }, (_, i) => out(`o${i}`, 25, 19 - i));
    expect(suggestReimbursements({ amount: 25, date: day(20) }, many, { limit: 3 })).toHaveLength(3);
  });
});
