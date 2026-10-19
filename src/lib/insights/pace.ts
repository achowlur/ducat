import { monthKeyBack, periodEndExclusive, periodStart } from './periods';
import { quantile, round2 } from './stats';

/**
 * Where the current month lands, from what has been spent so far.
 *
 * The projection is deliberately dull: assume the rest of the month looks like
 * the rest of a typical one, and never claim less than what is already known
 * to be due. "The rest of a typical month" is what typical months spent AFTER
 * this day, everyday spending only (travel and one-off purchases left out,
 * SpendingByCategoryPayload.everydayAfterDay): a straight share of the month
 * read a rent paid on the 2nd as still to come on the 17th, and projected a
 * month well above where it landed. Rows stored before the series fall
 * back to that share.
 * Everything interesting here is in what it REFUSES to say — a pace call is
 * only as good as its baseline, and there are three ways the baseline can be
 * too thin to speak from.
 */

/** Below this, the month has not told us enough. Day 3 of 31 says nothing. */
const MIN_ELAPSED = 0.25;
/**
 * A single month is an anecdote; two is the least that can be called typical.
 * The window itself is BAND_MONTHS (below): the last six months, the window
 * the over-pace band, the goals and the runway read, so the headline and the
 * OVER PACE alert agree on what "typical" is.
 */
const MIN_RECENT = 2;
/**
 * A period reaching back over fewer than two thirds of today's accounts is not
 * a smaller version of this month, it is a different portfolio, and its total
 * cannot be compared to one.
 */
const MIN_BASELINE_COVERAGE = 2 / 3;

/**
 * The baseline, and the typical range: the middle half of the last BAND_MONTHS complete months'
 * totals, drawn from at least BAND_MIN_MONTHS of them: the band /trends' This
 * month so far draws, from the same constants, so the two cannot disagree on
 * what a typical month is.
 */
export const BAND_MONTHS = 6;
export const BAND_MIN_MONTHS = 3;

/**
 * The one baseline: the last BAND_MONTHS comparable months. It replaced the
 * same month of the last three years (2026-10-19): when spending changes
 * within a year, past years' months describe an older lifestyle, and the
 * figure read (everyday spending AFTER the day) no longer carries the rent
 * that once made a trailing window blind to the months that differ.
 */
export type PaceBasis = 'TRAILING';
export type PaceRefusal = 'TOO_EARLY' | 'NO_BASELINE';

export interface PriorPeriod {
  period: string;
  total: number;
  /**
   * How many of today's accounts reached back into this period — the same
   * shape `periodCoverage` returns.
   *
   * Coverage is neither ignored nor treated as pass/fail here, because both
   * extremes failed on real data. Requiring COMPLETE coverage went dark for
   * months: one card opened part-way through the current month makes every
   * prior period incomplete. Ignoring it entirely offered "a typical July ran
   * $2234.07" against $10,540.56 spent — an artifact of seven of eight accounts not
   * existing yet, which reads as a five-fold overspend that never happened.
   *
   * So a period has to be COMPARABLE to be sampled at all, and the shortfall
   * of those that qualify is reported. Visibly incomplete beats silently
   * wrong; incomparable beats neither, and is refused.
   */
  coverage?: { covered: number; total: number };
  /** Everyday spending after each day of that month (index d = after day d); absent on older rows. */
  everydayAfterDay?: number[];
}

export interface Pace {
  period: string;
  dayOfPeriod: number;
  daysInPeriod: number;
  spentSoFar: number;
  /** Recurring charges falling due before the period ends. */
  committedRemaining: number;
  /** Median of the comparable periods, or null when there were too few. */
  typical: number | null;
  basis: PaceBasis | null;
  /** How many prior periods `typical` was drawn from. */
  basisCount: number;
  /**
   * Most accounts any sampled period was missing. Above zero, `typical` is
   * understated against today and the projection leans low — which is the
   * direction worth saying out loud, since being told you are under-spending
   * when you are not is the reassuring kind of wrong.
   */
  basisMissingAccounts: number;
  /**
   * What the rest of a typical month adds: the middle of the sample's
   * everyday spending after this day, or a share of its typical total on rows
   * without the series. Null with a refusal.
   */
  typicalRest: number | null;
  /** True when `typicalRest` came from the everyday series, false when from a share of the total. */
  restIsEveryday: boolean;
  /**
   * The top of a typical month: the 75th percentile of the last BAND_MONTHS
   * months' totals, the top of the band /trends draws. Null with a refusal
   * or with fewer than BAND_MIN_MONTHS comparable months to draw it from.
   */
  typicalHigh: number | null;
  /**
   * The same month a year ago, when it is comparable: what it spent in all,
   * for the working-out's seasonal aside. It is never part of the baseline.
   * Null with a refusal, or when that month has no row or is not comparable.
   */
  lastYear: { period: string; total: number } | null;
  /** Null whenever `refusal` is set — the two are never both present. */
  projected: number | null;
  refusal: PaceRefusal | null;
}

const DAY_MS = 86_400_000;

/**
 * Whether a period reaches back over enough of today's accounts to be compared
 * with one. Exported so the digest's baselines are gated by the same rule —
 * two answers to "is this month comparable?" on one screen would be one too
 * many.
 */
export function isComparableBaseline(coverage?: { covered: number; total: number }): boolean {
  if (coverage === undefined || coverage.total === 0) return true;
  return coverage.covered / coverage.total >= MIN_BASELINE_COVERAGE;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * @param priors Periods before this one, in any order, each carrying how many
 *   accounts it was missing. Coverage is REPORTED rather than filtered on —
 *   see `PriorPeriod.missingAccounts` for why excluding is the worse option.
 */
export function computePace(input: {
  period: string;
  now: Date;
  spentSoFar: number;
  committedRemaining: number;
  priors: PriorPeriod[];
}): Pace {
  const { period, now, spentSoFar, committedRemaining, priors } = input;
  const start = periodStart(period);
  const end = periodEndExclusive(period);

  const daysInPeriod = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const elapsedMs = Math.min(Math.max(now.getTime() - start.getTime(), 0), end.getTime() - start.getTime());
  const elapsedFraction = elapsedMs / (end.getTime() - start.getTime());
  const dayOfPeriod = Math.min(daysInPeriod, Math.floor(elapsedMs / DAY_MS) + 1);

  const base: Omit<
    Pace,
    | 'typical'
    | 'basis'
    | 'basisCount'
    | 'basisMissingAccounts'
    | 'typicalRest'
    | 'restIsEveryday'
    | 'typicalHigh'
    | 'lastYear'
    | 'projected'
    | 'refusal'
  > = {
    period,
    dayOfPeriod,
    daysInPeriod,
    spentSoFar: round2(spentSoFar),
    committedRemaining: round2(committedRemaining),
  };

  const refuse = (refusal: PaceRefusal): Pace => ({
    ...base,
    typical: null,
    basis: null,
    basisCount: 0,
    basisMissingAccounts: 0,
    typicalRest: null,
    restIsEveryday: false,
    typicalHigh: null,
    lastYear: null,
    projected: null,
    refusal,
  });

  if (elapsedFraction < MIN_ELAPSED) return refuse('TOO_EARLY');

  // The last BAND_MONTHS months, less any not comparable with today. A month
  // left out is not replaced by an older one: older months miss more
  // accounts and describe an older way of spending (recentMonths.ts, the
  // goals' window, keeps the same rule).
  const comparable = priors.filter((p) => p.period < period && isComparableBaseline(p.coverage));
  const recent = new Set(Array.from({ length: BAND_MONTHS }, (_, i) => monthKeyBack(start, i + 1)));
  const sample = comparable.filter((p) => recent.has(p.period));

  if (sample.length < MIN_RECENT) return refuse('NO_BASELINE');
  const basis: PaceBasis = 'TRAILING';

  const typical = round2(median(sample.map((p) => p.total)));
  // What a typical month still had left to spend after this day: from its
  // everyday spending when every sampled month carries the series, else a
  // share of the total.
  const series = sample.every((p) => p.everydayAfterDay !== undefined && p.everydayAfterDay.length > 0);
  const typicalRemaining = series
    ? Math.max(
        0,
        median(sample.map((p) => p.everydayAfterDay![Math.min(dayOfPeriod, p.everydayAfterDay!.length - 1)])),
      )
    : Math.max(0, typical * (1 - elapsedFraction));
  // Never project less than what is already known to fall due: the committed
  // charges are observed, the typical remainder is inferred, and an inference
  // should not talk over a fact.
  const remaining = Math.max(typicalRemaining, committedRemaining);

  // The top of the typical range, from the same months: what the chart's
  // band is, so it needs the band's minimum.
  const typicalHigh = sample.length >= BAND_MIN_MONTHS ? round2(quantile(sample.map((p) => p.total), 0.75)) : null;

  // The same month a year ago, said beside the baseline and never in it.
  const yearAgo = monthKeyBack(start, 12);
  const lastYearRow = comparable.find((p) => p.period === yearAgo);

  return {
    ...base,
    typical,
    basis,
    basisCount: sample.length,
    basisMissingAccounts: Math.max(
      0,
      ...sample.map((p) => (p.coverage === undefined ? 0 : p.coverage.total - p.coverage.covered)),
    ),
    typicalRest: round2(typicalRemaining),
    restIsEveryday: series,
    typicalHigh,
    lastYear: lastYearRow === undefined ? null : { period: lastYearRow.period, total: round2(lastYearRow.total) },
    projected: round2(spentSoFar + remaining),
    refusal: null,
  };
}

/**
 * What to do about a month projected ABOVE the typical range, or null when it
 * is not (or the pace call refused, or the period is not the month being
 * lived in: only a current pace carries a projection).
 *
 * - `perDay`: the room left under the top of the range, spread over the days
 *   left TODAY INCLUDED (today's spending is still coming in), so the last
 *   day of the month has one day left, never zero.
 * - `past`: spending so far is already beyond the top of the range.
 * - `committed`: room is left, but less than the recurring charges still due,
 *   which are not a daily amount to keep to.
 */
export type OverPace =
  | { kind: 'perDay'; perDay: number; daysLeft: number }
  | { kind: 'past'; over: number }
  | { kind: 'committed'; over: number };

export function overPace(pace: Pace): OverPace | null {
  if (pace.refusal !== null || pace.projected === null || pace.typicalHigh === null) return null;
  if (pace.projected <= pace.typicalHigh) return null;
  if (pace.spentSoFar > pace.typicalHigh) return { kind: 'past', over: round2(pace.spentSoFar - pace.typicalHigh) };
  const room = pace.typicalHigh - pace.spentSoFar;
  if (pace.committedRemaining > room) return { kind: 'committed', over: round2(pace.committedRemaining - room) };
  const daysLeft = Math.max(1, pace.daysInPeriod - pace.dayOfPeriod + 1);
  return { kind: 'perDay', perDay: round2(room / daysLeft), daysLeft };
}
