import { describe, expect, it } from 'vitest';
import { fractionBelow, mad, median, pctDelta, robustZ, ROBUST_Z_CAP } from './stats';

describe('median and mad', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('mad is the median absolute deviation, not the mean one', () => {
    expect(mad([1, 1, 1, 1, 100])).toBe(0);
  });
});

describe('robustZ', () => {
  it('caps rather than returning Infinity on constant history', () => {
    expect(robustZ(500, [10, 10, 10, 10])).toBe(ROBUST_Z_CAP);
    expect(robustZ(10, [10, 10, 10, 10])).toBe(0);
  });
});

describe('fractionBelow', () => {
  it('is the fraction of history the value exceeds', () => {
    expect(fractionBelow(50, [10, 20, 30, 40])).toBe(1);
    expect(fractionBelow(25, [10, 20, 30, 40])).toBe(0.5);
    expect(fractionBelow(5, [10, 20, 30, 40])).toBe(0);
  });

  it('counts strictly-below, so matching the largest is not "higher than all"', () => {
    expect(fractionBelow(40, [10, 20, 30, 40])).toBe(0.75);
  });

  it('is 0 for empty history rather than dividing by zero', () => {
    expect(fractionBelow(100, [])).toBe(0);
  });

  // The reason this exists: median and rank disagree wildly on a heavy tail, and
  // the rank is the honest one to show. Here 6 of 8 values sit under a fifth of
  // the flagged amount, yet it is only larger than 87% of them.
  it('describes a heavy tail more honestly than a ratio does', () => {
    const dining = [4, 5, 6, 8, 12, 18, 60, 95];
    expect(median(dining)).toBe(10);
    expect(fractionBelow(73, dining)).toBe(0.875);
    expect(73 / median(dining)).toBe(7.3); // the number we stopped showing
  });
});

describe('pctDelta', () => {
  it('refuses a non-positive base — a sign flip is not a percentage increase', () => {
    expect(pctDelta(4655.60, -409.73)).toBeNull();
    expect(pctDelta(100, 0)).toBeNull();
    expect(pctDelta(150, 100)).toBe(0.5);
  });
});
