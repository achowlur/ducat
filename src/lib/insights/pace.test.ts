import { describe, expect, it } from 'vitest';
import { computePace, type PriorPeriod } from './pace';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

const julys: PriorPeriod[] = [
  { period: '2024-07', total: 3000 },
  { period: '2025-07', total: 4000 },
];

function pace(over: Partial<Parameters<typeof computePace>[0]> = {}) {
  return computePace({
    period: '2026-07',
    now: utc(2026, 7, 16), // ~half the month gone
    spentSoFar: 1800,
    committedRemaining: 0,
    priors: julys,
    ...over,
  });
}

describe('computePace', () => {
  it('reports where the month stands before projecting anything', () => {
    const p = pace();
    expect(p.dayOfPeriod).toBe(16);
    expect(p.daysInPeriod).toBe(31);
    expect(p.spentSoFar).toBe(1800);
  });

  it('projects from the same calendar month in prior years', () => {
    const p = pace();
    expect(p.basis).toBe('SAME_MONTH');
    expect(p.basisCount).toBe(2);
    expect(p.typical).toBe(3500); // median of 3000 and 4000
    // ~half of July left, so ~half a typical July still to come.
    expect(p.projected).toBeGreaterThan(1800);
    expect(p.projected).toBeLessThan(1800 + 3500);
  });

  it('REFUSES a pace call early in the month, but still states the facts', () => {
    const p = pace({ now: utc(2026, 7, 3), spentSoFar: 200 });
    expect(p.refusal).toBe('TOO_EARLY');
    expect(p.projected).toBeNull();
    expect(p.typical).toBeNull();
    // The observations survive the refusal — only the inference is withheld.
    expect(p.spentSoFar).toBe(200);
    expect(p.dayOfPeriod).toBe(3);
  });

  it('REFUSES when there are too few comparable periods', () => {
    const p = pace({ priors: [{ period: '2025-07', total: 4000 }] });
    expect(p.refusal).toBe('NO_BASELINE');
    expect(p.projected).toBeNull();
  });

  it('falls back to a trailing average when prior Julys are too few', () => {
    const p = pace({
      priors: [
        { period: '2026-04', total: 2000 },
        { period: '2026-05', total: 2400 },
        { period: '2026-06', total: 2200 },
        { period: '2025-07', total: 4000 }, // only one prior July
      ],
    });
    expect(p.basis).toBe('TRAILING');
    expect(p.basisCount).toBe(3);
    expect(p.typical).toBe(2200); // median of the three most recent
  });

  it('takes the three MOST RECENT periods for the trailing basis', () => {
    const p = pace({
      priors: [
        { period: '2025-01', total: 99999 }, // ancient, must not be sampled
        { period: '2026-04', total: 2000 },
        { period: '2026-05', total: 2400 },
        { period: '2026-06', total: 2200 },
      ],
    });
    expect(p.typical).toBe(2200);
  });

  it('never projects below what is already committed', () => {
    // A quiet month whose typical remainder is small, but $2332.56 is known to fall
    // due before it ends. An inference must not talk over an observation.
    const p = pace({
      spentSoFar: 100,
      committedRemaining: 900,
      priors: [
        { period: '2024-07', total: 200 },
        { period: '2025-07', total: 200 },
      ],
    });
    expect(p.projected).toBe(1000);
  });

  it('ignores periods at or after the one being projected', () => {
    const p = pace({
      priors: [...julys, { period: '2026-07', total: 9999 }, { period: '2026-08', total: 9999 }],
    });
    expect(p.basisCount).toBe(2);
    expect(p.typical).toBe(3500);
  });

  it('clamps a period already over to its own length', () => {
    // Browsing a finished month: elapsed cannot exceed 100%, and the day
    // counter cannot run past the month's last day.
    const p = pace({ period: '2026-06', now: utc(2026, 7, 20), priors: [
      { period: '2024-06', total: 3000 },
      { period: '2025-06', total: 3000 },
    ] });
    expect(p.daysInPeriod).toBe(30);
    expect(p.dayOfPeriod).toBe(30);
    // Nothing of the month remains, so the projection is what was spent.
    expect(p.projected).toBe(1800);
  });

  it('samples a slightly-incomplete baseline and reports the shortfall', () => {
    // The case that forced this: the newest card was opened part-way through
    // the current month, so EVERY prior period is coverage-incomplete.
    // Discarding them leaves no baseline and the feature goes dark.
    const p = pace({
      priors: [
        { period: '2024-07', total: 3000, coverage: { covered: 7, total: 8 } },
        { period: '2025-07', total: 4000, coverage: { covered: 6, total: 8 } },
      ],
    });
    expect(p.refusal).toBeNull();
    expect(p.typical).toBe(3500);
    expect(p.basisMissingAccounts).toBe(2); // the worst of the sampled periods
  });

  it('REFUSES a baseline too sparse to compare against, rather than caveating it', () => {
    // 3 of 21 accounts is not a smaller version of this month, it is a
    // different portfolio: real data offered "a typical July ran $2234.07" against
    // $10,540.56 spent, which reads as a fivefold overspend that never happened.
    const p = pace({
      priors: [
        { period: '2024-07', total: 800, coverage: { covered: 1, total: 8 } },
        { period: '2025-07', total: 900, coverage: { covered: 3, total: 8 } },
      ],
    });
    expect(p.refusal).toBe('NO_BASELINE');
    expect(p.typical).toBeNull();
  });

  it('falls back to recent comparable months when the old ones are too sparse', () => {
    const p = pace({
      priors: [
        { period: '2024-07', total: 800, coverage: { covered: 1, total: 8 } },
        { period: '2025-07', total: 900, coverage: { covered: 2, total: 8 } },
        { period: '2026-05', total: 3800, coverage: { covered: 7, total: 8 } },
        { period: '2026-06', total: 4200, coverage: { covered: 7, total: 8 } },
      ],
    });
    expect(p.basis).toBe('TRAILING');
    expect(p.basisCount).toBe(2);
    expect(p.typical).toBe(4000);
    expect(p.basisMissingAccounts).toBe(1);
  });

  it('reports zero missing when the baseline is fully covered', () => {
    expect(pace().basisMissingAccounts).toBe(0);
  });

  it('handles a February baseline without the day count leaking across months', () => {
    const p = pace({
      period: '2026-02',
      now: utc(2026, 2, 20),
      priors: [
        { period: '2024-02', total: 1000 },
        { period: '2025-02', total: 1400 },
      ],
    });
    expect(p.daysInPeriod).toBe(28);
    expect(p.typical).toBe(1200);
  });
});
