import { periodEndExclusive, periodStart } from './periods';
import { round2 } from './stats';

/**
 * Where the current month lands, from what has been spent so far.
 *
 * The projection is deliberately dull: assume the rest of the month looks like
 * a typical one, and never claim less than what is already known to be due.
 * Everything interesting here is in what it REFUSES to say — a pace call is
 * only as good as its baseline, and there are three ways the baseline can be
 * too thin to speak from.
 */

/** Below this, the month has not told us enough. Day 3 of 31 says nothing. */
const MIN_ELAPSED = 0.25;
/** A single prior year is an anecdote; two is the least that can average. */
const MIN_SAME_MONTH = 2;
/** How far back the fallback reaches, and how much of it must be usable. */
const TRAILING_WINDOW = 3;
const MIN_TRAILING = 2;
/**
 * A period reaching back over fewer than two thirds of today's accounts is not
 * a smaller version of this month, it is a different portfolio, and its total
 * cannot be compared to one.
 */
const MIN_BASELINE_COVERAGE = 2 / 3;

export type PaceBasis = 'SAME_MONTH' | 'TRAILING';
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

/** "2026-07" → 7. Period keys are always YYYY-MM here. */
function monthOf(period: string): number {
  return Number(period.slice(5, 7));
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
    'typical' | 'basis' | 'basisCount' | 'basisMissingAccounts' | 'projected' | 'refusal'
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
    projected: null,
    refusal,
  });

  if (elapsedFraction < MIN_ELAPSED) return refuse('TOO_EARLY');

  // Same calendar month in prior years first: a trailing average is stable
  // exactly because rent dominates it, which is what makes it blind to the
  // months that genuinely differ.
  const comparable = priors.filter((p) => p.period < period && isComparableBaseline(p.coverage));

  const month = monthOf(period);
  const sameMonth = comparable.filter((p) => monthOf(p.period) === month);
  const trailing = [...comparable]
    .sort((a, b) => (a.period < b.period ? 1 : -1))
    .slice(0, TRAILING_WINDOW);

  let basis: PaceBasis | null = null;
  let sample: PriorPeriod[] = [];
  if (sameMonth.length >= MIN_SAME_MONTH) {
    basis = 'SAME_MONTH';
    sample = sameMonth;
  } else if (trailing.length >= MIN_TRAILING) {
    basis = 'TRAILING';
    sample = trailing;
  }

  if (basis === null) return refuse('NO_BASELINE');

  const typical = round2(median(sample.map((p) => p.total)));
  // What a typical month still had left to spend at this point.
  const typicalRemaining = Math.max(0, typical * (1 - elapsedFraction));
  // Never project less than what is already known to fall due: the committed
  // charges are observed, the typical remainder is inferred, and an inference
  // should not talk over a fact.
  const remaining = Math.max(typicalRemaining, committedRemaining);

  return {
    ...base,
    typical,
    basis,
    basisCount: sample.length,
    basisMissingAccounts: Math.max(
      0,
      ...sample.map((p) => (p.coverage === undefined ? 0 : p.coverage.total - p.coverage.covered)),
    ),
    projected: round2(spentSoFar + remaining),
    refusal: null,
  };
}
