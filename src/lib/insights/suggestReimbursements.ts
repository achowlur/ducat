/**
 * Ranks the outflows an inflow might be paying back.
 *
 * Date proximity alone is a bad ranker: for a $116.63 Zelle, a $5,183.46 rent payment
 * from yesterday sorts above the $116.63 dinner from last week, which is never the
 * right answer. Reimbursements are recognisable by their AMOUNT relationship —
 * the whole expense, or a clean 1/n share of a split bill — so amount evidence
 * leads and date proximity breaks ties.
 */
export interface SuggestInflow {
  /** Positive magnitude. */
  amount: number;
  date: Date;
}

export interface SuggestOutflow {
  id: string;
  /** Signed or magnitude; only |amount| is used. */
  amount: number;
  date: Date;
  /**
   * Whether this is the kind of expense people split. Defaults to true.
   * Arithmetic alone can't tell "1/5 of a dinner" from "1/3 of an advisory
   * fee" — both divide evenly — but nobody splits rent, taxes, or bank fees
   * with the friend who Venmo'd them. Marking those false stops the ranker
   * inventing confident nonsense.
   */
  splittable?: boolean;
}

export interface ScoredCandidate {
  id: string;
  /** 0..1, used for ordering only. */
  score: number;
  /** Why it matched, for the picker: "exact amount", "1/3 of $90.00". */
  reason: string;
  /**
   * The AMOUNT evidence is conclusive (exact repayment or a clean 1/n share),
   * independent of how long the repayment took. Drives the "worth a look" hint;
   * the combined score would wrongly demote an exact match from three weeks ago
   * below a same-day coincidence.
   */
  strong: boolean;
}

const DAY_MS = 86_400_000;
const cents = (n: number): number => Math.round(Math.abs(n) * 100);
const money = (c: number): string => `$${(c / 100).toFixed(2)}`;

/** Largest split we'll claim to recognise; beyond this the evidence is noise. */
const MAX_SPLIT = 8;

/** People round their share up to the dollar, so an exact 1/n is the exception. */
const ROUNDING_TOLERANCE = 0.02;

function amountEvidence(
  inflow: number,
  outflow: number,
  splittable: boolean,
): { score: number; reason: string } | null {
  // You cannot be paid back more than was spent.
  if (inflow > outflow || outflow === 0) return null;
  // Repaying the whole thing is plausible for any expense, split or not.
  if (inflow === outflow) return { score: 1, reason: 'exact amount' };
  if (!splittable) return { score: 0.3, reason: `part of ${money(outflow)}` };

  for (let n = 2; n <= MAX_SPLIT; n++) {
    // Tolerance grows with n: splitting an odd total rounds each share.
    if (Math.abs(inflow * n - outflow) <= n) {
      return { score: 0.85, reason: `1/${n} of ${money(outflow)}` };
    }
  }
  // A rounded share: $118.75 four ways is $61.55 each, and people send $62.2.
  const slack = Math.max(MAX_SPLIT, Math.round(outflow * ROUNDING_TOLERANCE));
  for (let n = 2; n <= MAX_SPLIT; n++) {
    if (Math.abs(inflow * n - outflow) <= slack) {
      return { score: 0.7, reason: `≈1/${n} of ${money(outflow)}` };
    }
  }
  return { score: 0.3, reason: `part of ${money(outflow)}` };
}

/**
 * Repayment normally follows the expense. A few days of lead is allowed —
 * someone can pay you before the charge posts — but it's weaker evidence.
 */
function dateEvidence(gapDays: number, windowDays: number): number {
  if (gapDays > windowDays || gapDays < -3) return 0;
  const decay = 1 / (1 + Math.abs(gapDays) / 14);
  return gapDays < 0 ? decay * 0.6 : decay;
}

export function suggestReimbursements(
  inflow: SuggestInflow,
  outflows: SuggestOutflow[],
  options: { limit?: number; windowDays?: number; minScore?: number } = {},
): ScoredCandidate[] {
  const { limit = 5, windowDays = 45, minScore = 0.05 } = options;
  const inflowCents = cents(inflow.amount);
  if (inflowCents === 0) return [];

  const scored: (ScoredCandidate & { gap: number })[] = [];
  for (const out of outflows) {
    const amount = amountEvidence(inflowCents, cents(out.amount), out.splittable ?? true);
    if (amount === null) continue;
    const gap = (inflow.date.getTime() - out.date.getTime()) / DAY_MS;
    const date = dateEvidence(gap, windowDays);
    if (date === 0) continue;
    const score = amount.score * date;
    if (score < minScore) continue;
    scored.push({ id: out.id, score, reason: amount.reason, strong: amount.score >= 0.7, gap });
  }

  return scored
    .sort((a, b) => b.score - a.score || Math.abs(a.gap) - Math.abs(b.gap))
    .slice(0, limit)
    .map(({ id, score, reason, strong }) => ({ id, score, reason, strong }));
}
