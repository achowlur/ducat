import { describe, expect, it } from 'vitest';
import { computePace, overPace, type PriorPeriod } from './pace';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

// Invented: the two months before July 2026.
const recent: PriorPeriod[] = [
  { period: '2026-05', total: 3000 },
  { period: '2026-06', total: 4000 },
];

function pace(over: Partial<Parameters<typeof computePace>[0]> = {}) {
  return computePace({
    period: '2026-07',
    now: utc(2026, 7, 16), // ~half the month gone
    spentSoFar: 1800,
    committedRemaining: 0,
    priors: recent,
    ...over,
  });
}

/** Invented months before July 2026, `n` back from June, each with a flat everyday rest. */
const monthsBack = (totals: number[]): PriorPeriod[] =>
  totals.map((total, i) => {
    const d = new Date(Date.UTC(2026, 5 - i, 1));
    return { period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, total };
  });

describe('computePace', () => {
  // Invented: rent of $1,800 on the 2nd and $40 a day of everyday spending,
  // so by the 16th most of a $3,000 month is already spent.
  it('projects the rest of the month from what typical months spent after this day', () => {
    const after = (d: number) => Math.max(0, (31 - d) * 40);
    const withSeries: PriorPeriod[] = recent.map((p) => ({ ...p, everydayAfterDay: Array.from({ length: 32 }, (_, d) => after(d)) }));
    const p = pace({ priors: withSeries, spentSoFar: 2400 });
    expect(p.restIsEveryday).toBe(true);
    expect(p.typicalRest).toBe(600); // 15 days after the 16th
    expect(p.projected).toBe(3000);
    // A share of the month would have counted the rent again.
    expect(pace({ spentSoFar: 2400 }).projected!).toBeGreaterThan(4000);
  });

  it('falls back to a share of the month when a sampled month predates the series', () => {
    const mixed: PriorPeriod[] = [{ ...recent[0], everydayAfterDay: new Array(32).fill(100) }, recent[1]];
    expect(pace({ priors: mixed }).restIsEveryday).toBe(false);
  });

  it('reports where the month stands before projecting anything', () => {
    const p = pace();
    expect(p.dayOfPeriod).toBe(16);
    expect(p.daysInPeriod).toBe(31);
    expect(p.spentSoFar).toBe(1800);
  });

  it('projects from the recent months', () => {
    const p = pace();
    expect(p.basis).toBe('TRAILING');
    expect(p.basisCount).toBe(2);
    expect(p.typical).toBe(3500); // the middle of 3000 and 4000
    // ~half of July left, so ~half a typical month still to come.
    expect(p.projected).toBeGreaterThan(1800);
    expect(p.projected).toBeLessThan(1800 + 3500);
  });

  // Nine months back, the oldest three from a dearer life: the baseline is
  // the last six, never a window that reaches back to them.
  it('reads only the last six months, never further back', () => {
    const p = pace({ priors: monthsBack([2000, 2100, 2200, 2300, 2400, 2500, 9000, 9000, 9000]) });
    expect(p.basisCount).toBe(6);
    expect(p.typical).toBe(2250);
  });

  it('skips a month under the coverage bar and never back-fills it with an older one', () => {
    const priors = monthsBack([2000, 2100, 2200, 2300, 2400, 2500, 9000]);
    priors[2] = { ...priors[2], coverage: { covered: 1, total: 8 } }; // April, a different portfolio
    const p = pace({ priors });
    expect(p.refusal).toBeNull();
    expect(p.basisCount).toBe(5); // December 2025 is not brought in to make six
    expect(p.typical).toBe(2300); // 2000, 2100, 2300, 2400, 2500
  });

  // Invented: five quiet months and one with a big week after the 16th.
  it('takes the MIDDLE of the months after this day, never the mean', () => {
    const rests = [500, 520, 480, 510, 490, 3000];
    const priors = monthsBack([3000, 3000, 3000, 3000, 3000, 3000]).map((p, i) => ({
      ...p,
      everydayAfterDay: new Array(32).fill(rests[i]),
    }));
    const p = pace({ priors });
    expect(p.restIsEveryday).toBe(true);
    expect(p.typicalRest).toBe(505); // the mean would say 917
  });

  it('REFUSES a pace call early in the month, but still states the facts', () => {
    const p = pace({ now: utc(2026, 7, 3), spentSoFar: 200 });
    expect(p.refusal).toBe('TOO_EARLY');
    expect(p.projected).toBeNull();
    expect(p.typical).toBeNull();
    expect(p.lastYear).toBeNull();
    // The observations survive the refusal — only the inference is withheld.
    expect(p.spentSoFar).toBe(200);
    expect(p.dayOfPeriod).toBe(3);
  });

  it('REFUSES when there are too few comparable periods in the window', () => {
    const p = pace({ priors: [{ period: '2026-06', total: 4000 }, { period: '2025-07', total: 4000 }] });
    expect(p.refusal).toBe('NO_BASELINE');
    expect(p.projected).toBeNull();
  });

  it('names the same month a year ago beside the baseline, never in it', () => {
    const p = pace({ priors: [...recent, { period: '2025-07', total: 9000 }] });
    expect(p.lastYear).toEqual({ period: '2025-07', total: 9000 });
    expect(p.basisCount).toBe(2);
    expect(p.typical).toBe(3500);
  });

  it('leaves the same month a year ago out when it is not comparable, or absent', () => {
    const sparse = pace({ priors: [...recent, { period: '2025-07', total: 900, coverage: { covered: 2, total: 8 } }] });
    expect(sparse.lastYear).toBeNull();
    expect(pace().lastYear).toBeNull();
  });

  it('never projects below what is already committed', () => {
    // A quiet month whose typical remainder is small, but $900 is known to fall
    // due before it ends. An inference must not talk over an observation.
    const p = pace({
      spentSoFar: 100,
      committedRemaining: 900,
      priors: [
        { period: '2026-05', total: 200 },
        { period: '2026-06', total: 200 },
      ],
    });
    expect(p.projected).toBe(1000);
  });

  it('ignores periods at or after the one being projected', () => {
    const p = pace({
      priors: [...recent, { period: '2026-07', total: 9999 }, { period: '2026-08', total: 9999 }],
    });
    expect(p.basisCount).toBe(2);
    expect(p.typical).toBe(3500);
  });

  it('clamps a period already over to its own length', () => {
    // Browsing a finished month: elapsed cannot exceed 100%, and the day
    // counter cannot run past the month's last day.
    const p = pace({ period: '2026-06', now: utc(2026, 7, 20), priors: [
      { period: '2026-04', total: 3000 },
      { period: '2026-05', total: 3000 },
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
        { period: '2026-05', total: 3000, coverage: { covered: 7, total: 8 } },
        { period: '2026-06', total: 4000, coverage: { covered: 6, total: 8 } },
      ],
    });
    expect(p.refusal).toBeNull();
    expect(p.typical).toBe(3500);
    expect(p.basisMissingAccounts).toBe(2); // the worst of the sampled periods
  });

  it('REFUSES a baseline too sparse to compare against, rather than caveating it', () => {
    // 3 of 8 accounts is not a smaller version of this month, it is a
    // different portfolio, which reads as a fivefold overspend that never happened.
    const p = pace({
      priors: [
        { period: '2026-05', total: 800, coverage: { covered: 1, total: 8 } },
        { period: '2026-06', total: 900, coverage: { covered: 3, total: 8 } },
      ],
    });
    expect(p.refusal).toBe('NO_BASELINE');
    expect(p.typical).toBeNull();
  });

  it('reports zero missing when the baseline is fully covered', () => {
    expect(pace().basisMissingAccounts).toBe(0);
  });

  it('handles a February baseline without the day count leaking across months', () => {
    const p = pace({
      period: '2026-02',
      now: utc(2026, 2, 20),
      priors: [
        { period: '2025-12', total: 1000 },
        { period: '2026-01', total: 1400 },
      ],
    });
    expect(p.daysInPeriod).toBe(28);
    expect(p.typical).toBe(1200);
  });
});

// Invented: April to June of 3000, 4000 and 3600 are the last six months.
// The top of a typical month is the 75th percentile of those three, 3800;
// with no everyday series the rest of the month is a share of their middle,
// 3600.
const typicalMonths: PriorPeriod[] = [
  { period: '2026-04', total: 3000 },
  { period: '2026-05', total: 4000 },
  { period: '2026-06', total: 3600 },
];
describe('overPace', () => {
  const over = (o: Partial<Parameters<typeof computePace>[0]> = {}) => pace({ priors: typicalMonths, ...o });

  it('is the room under the top of the range, spread over the days left', () => {
    const p = over({ spentSoFar: 2400 });
    expect(p.typicalHigh).toBe(3800);
    expect(p.projected).toBe(4200);
    // 1400 of room over the 16th to the 31st: 16 days, today included.
    expect(overPace(p)).toEqual({ kind: 'perDay', perDay: 87.5, daysLeft: 16 });
  });

  it('says nothing for a month projected inside the range', () => {
    const p = over({ spentSoFar: 1800 });
    expect(p.projected!).toBeLessThan(p.typicalHigh!);
    expect(overPace(p)).toBeNull();
  });

  it('says how far past the range a month already is', () => {
    expect(overPace(over({ spentSoFar: 3900 }))).toEqual({ kind: 'past', over: 100 });
  });

  it('leaves the last day of the month ONE day, never zero', () => {
    const p = over({ now: utc(2026, 7, 31), spentSoFar: 3750 });
    expect(p.dayOfPeriod).toBe(31);
    expect(overPace(p)).toEqual({ kind: 'perDay', perDay: 50, daysLeft: 1 });
  });

  it('does not ask for a daily figure the recurring charges still due make impossible', () => {
    // 800 of room, 900 of charges that are due whatever is spent per day.
    expect(overPace(over({ spentSoFar: 3000, committedRemaining: 900 }))).toEqual({ kind: 'committed', over: 100 });
  });

  it('is silent when the pace call refuses', () => {
    const early = over({ now: utc(2026, 7, 3), spentSoFar: 5000 });
    expect(early.refusal).toBe('TOO_EARLY');
    expect(early.typicalHigh).toBeNull();
    expect(overPace(early)).toBeNull();
    const thin = over({ priors: [], spentSoFar: 5000 });
    expect(thin.refusal).toBe('NO_BASELINE');
    expect(overPace(thin)).toBeNull();
  });

  it('is silent without three months to draw a range from, as the chart is', () => {
    const p = pace({ spentSoFar: 5000 }); // two months only
    expect(p.projected).not.toBeNull();
    expect(p.typicalHigh).toBeNull();
    expect(overPace(p)).toBeNull();
  });

  it('reads only the last six months for the range', () => {
    const old = [...typicalMonths, { period: '2025-12', total: 9000 }]; // older than six months before July
    expect(over({ priors: old }).typicalHigh).toBe(3800);
  });
});
