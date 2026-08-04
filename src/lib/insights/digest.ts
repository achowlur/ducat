import type {
  AnomalyPayload,
  RecurringCadence,
  RecurringChargePayload,
  SpendingByCategoryPayload,
} from '../../types/contracts';
import { round2 } from './stats';

/**
 * The few things worth leading with this month, ranked by what they cost over
 * the next year.
 *
 * Two rules do all the work here, and both are deliberate reversals of how the
 * rest of the engine ranks things.
 *
 * FIRST: rank by DOLLARS AT STAKE FORWARD, not by how unusual something is.
 * The anomaly analyzer ranks by deviation, which is right for its job — but a
 * 4x deviation on a $31.1 charge matters less than a 3% drift on rent. Ranking
 * on forward dollars also attacks the flooding problem from a new angle: a wild
 * restaurant week loses to a quiet subscription rise, correctly, because one is
 * over and the other repeats.
 *
 * SECOND: a change has to carry a forward CONSEQUENCE to earn a place at all.
 * "Dining up 34%" is a number; "up 34%, ~$2,850.9/yr if it holds" is a decision.
 * That is why a one-off is scored at its own amount and never annualised — it
 * happened once, so once is what is at stake.
 */

export type DigestKind = 'CATEGORY_DRIFT' | 'PRICE_RISE' | 'NEW_COMMITMENT' | 'ONE_OFF';

export interface DigestItem {
  kind: DigestKind;
  /** Category, merchant, or the transaction's description. */
  subject: string;
  /** This period's figure: the spend, the new price, or the amount. */
  amount: number;
  /** What it is measured against; null for a one-off, which has no baseline. */
  baseline: number | null;
  /** Dollars over the next twelve months if it holds — the ranking key. */
  stake: number;
  /**
   * WHAT THIS WAS BUILT FROM, so the streams below can decline to print the
   * same finding a second time.
   *
   * The digest is the page's lead and the streams are its detail, but they
   * read the same rows, so a promoted finding appeared twice ~400px apart in
   * different words and a different order — and for a category, against a
   * different baseline entirely: July's Groceries led with "$448.89, against
   * $107.12 in comparable months" and reappeared as "total $448.89 — higher
   * than all prior months (median $78.24)". Two medians for one category on
   * one screen, because the digest measures against COMPARABLE periods and
   * the anomaly against ALL history. Both are correct; printing both without
   * saying so is not.
   *
   * Null for items with no single source row (a price rise and a new
   * commitment are read from the recurring stream, which is a separate
   * question and not touched here).
   */
  dedupeKey: string | null;
  /**
   * ONE_OFF only: the anomaly's RANK, carried so promotion does not silently
   * drop it. `higherThan` is the anomaly section's whole contribution — the
   * convention requires a rank rather than a ratio — and the digest's own
   * "against $X typical" states the median without it.
   */
  rank?: { percentileOfHistory: number | undefined; of: string };
}

/**
 * The identity a digest item and an insight row share, so the page can match
 * one against the other. Exported because BOTH sides must compute it the same
 * way, and two copies of this rule would drift.
 */
export function anomalyDedupeKey(a: {
  kind: 'TRANSACTION' | 'CATEGORY_TOTAL';
  transactionId: string | null;
  categoryId: string | null;
  categoryName: string | null;
}): string | null {
  if (a.kind === 'TRANSACTION') {
    return a.transactionId === null ? null : `txn:${a.transactionId}`;
  }
  return `cat:${keyOf(a)}`;
}

/** /insights reads monthly periods, so a period is a month. */
const PERIODS_PER_YEAR = 12;

const CADENCE_PER_YEAR: Record<RecurringCadence, number> = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  MONTHLY: 12,
  QUARTERLY: 4,
  YEARLY: 1,
};

/**
 * Below this a finding cannot change a decision, so it is noise however
 * unusual it is. Deliberately LOW: the anomaly pass learned that a $100 floor
 * discarded a $95 annual card fee and a $186.6 advisory fee, both of which were
 * worth seeing.
 */
const MIN_STAKE = 60;

/** Hard cap, as a rule and not a default — `maxPerBaseline: 1` is the precedent. */
const MAX_ITEMS = 4;

/** A category needs this many prior periods with actual spending to have a baseline. */
const MIN_CATEGORY_SAMPLES = 2;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function keyOf(c: { categoryId: string | null; categoryName: string | null }): string {
  return c.categoryId ?? `name:${c.categoryName ?? 'uncategorized'}`;
}

export function computeDigest(input: {
  spending: SpendingByCategoryPayload | null;
  /** Comparable prior periods only — the caller applies the coverage gate. */
  priorSpending: SpendingByCategoryPayload[];
  recurring: RecurringChargePayload[];
  anomalies: AnomalyPayload[];
  /** Occurrences at which the detector first recognises a charge. */
  minOccurrences: number;
}): DigestItem[] {
  const { spending, priorSpending, recurring, anomalies, minOccurrences } = input;
  const items: DigestItem[] = [];

  // --- Categories drifting up against their own comparable history ----------
  // A median across several periods rather than last month's figure: a two-point
  // delta cannot tell a category rising four months running from one that
  // bounced once, and it is the difference that decides whether this repeats.
  if (spending !== null) {
    const history = new Map<string, number[]>();
    for (const prior of priorSpending) {
      for (const c of prior.categories) {
        // Only periods where the category actually had spending, the same rule
        // the anomaly baselines use — counting empty periods as $0 drags the
        // median toward zero for anything that started part-way through.
        if (c.spending <= 0) continue;
        const k = keyOf(c);
        history.set(k, [...(history.get(k) ?? []), c.spending]);
      }
    }

    for (const c of spending.categories) {
      if (c.spending <= 0) continue;
      const past = history.get(keyOf(c)) ?? [];
      if (past.length < MIN_CATEGORY_SAMPLES) continue;
      const baseline = median(past);
      const delta = c.spending - baseline;
      // Increases only. A category falling is good news and does not need
      // attention; /trends already shows it either way.
      if (delta <= 0) continue;
      items.push({
        kind: 'CATEGORY_DRIFT',
        subject: c.categoryName ?? 'Uncategorized',
        amount: round2(c.spending),
        baseline: round2(baseline),
        stake: round2(delta * PERIODS_PER_YEAR),
        dedupeKey: `cat:${keyOf(c)}`,
      });
    }
  }

  // --- Subscriptions that changed price, or just appeared ------------------
  for (const r of recurring) {
    const perYear = CADENCE_PER_YEAR[r.cadence];
    if (r.priceIncreased && r.previousAverageAmount !== null) {
      const delta = r.lastAmount - r.previousAverageAmount;
      if (delta > 0) {
        items.push({
          kind: 'PRICE_RISE',
          subject: r.merchant,
          amount: round2(r.lastAmount),
          baseline: round2(r.previousAverageAmount),
          stake: round2(delta * perYear),
          dedupeKey: null,
        });
      }
    } else if (r.occurrences <= minOccurrences) {
      // Only just enough charges to be recognised, so this is the first time
      // the app could have told you about it. The whole cost is at stake,
      // because the commitment itself is the news.
      items.push({
        kind: 'NEW_COMMITMENT',
        subject: r.merchant,
        amount: round2(r.averageAmount),
        baseline: null,
        stake: round2(r.averageAmount * perYear),
        dedupeKey: null,
      });
    }
  }

  // --- One-offs big enough to outweigh a small recurring change ------------
  // Scored at face value, never annualised. CATEGORY_TOTAL anomalies are left
  // out: category movement is already covered above, and better, against a
  // median of comparable periods rather than of all history.
  for (const a of anomalies) {
    if (a.kind !== 'TRANSACTION') continue;
    items.push({
      kind: 'ONE_OFF',
      subject: a.description ?? a.categoryName ?? 'Transaction',
      amount: round2(a.amount),
      baseline: round2(a.typicalAmount),
      stake: round2(a.amount),
      dedupeKey: anomalyDedupeKey(a),
      rank: {
        percentileOfHistory: a.percentileOfHistory,
        of: `your ${a.categoryName ?? 'spending here'}`,
      },
    });
  }

  return items
    .filter((i) => i.stake >= MIN_STAKE)
    .sort((a, b) => b.stake - a.stake || b.amount - a.amount)
    .slice(0, MAX_ITEMS);
}
