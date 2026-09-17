import { payeeKey } from './grouping';
import { userCategoryRuleFor, type RuleData, type RuleTxn } from './rules';

/**
 * Pre-filled categories for P2P payments awaiting confirmation. Nothing here
 * writes: a suggestion is offered beside the row and becomes a category only
 * when the operator confirms it, which is the whole point — one person can be
 * paid for rent in one month and dinner in the next, and a rule applied unseen
 * gets that wrong silently.
 *
 * Three sources, most specific first:
 *  1. SAME PAYEE, SAME DIRECTION, SAME AMOUNT (within AMOUNT_TOLERANCE) as a
 *     payment already categorized — the recurring case, and the strongest
 *     evidence there is short of a person saying so.
 *  2. A USER RULE for the payee — made in grouped review before P2P rules
 *     became suggestions.
 *  3. The payee's CLEAR FAVOURITE in that direction: a category used at
 *     least twice and more often than any other. A tie, or a single past
 *     payment, is a guess dressed as evidence — "1 of 3 past payments" said
 *     only that all three differed — so it suggests nothing.
 * The payee is `payeeKey` of the description, the same key grouped review
 * writes its rules from, so a suggestion and a group decision name the same
 * person. Direction matters: money a friend sends you and money you send them
 * are rarely the same category.
 */

/** Relative, so a $1,200 rent that became $1,236 still reads as the same payment. */
export const AMOUNT_TOLERANCE = 0.05;

/** A payee's favourite category needs at least this many payments behind it. */
export const MIN_FAVOURITE = 2;

export interface P2PTarget extends RuleTxn {
  date: Date;
}

export interface P2PHistoryRow {
  amount: number; // signed
  date: Date;
  description: string;
  categoryId: string;
}

export type SuggestionReason =
  | { kind: 'SAME_AMOUNT'; date: Date }
  | { kind: 'RULE' }
  | { kind: 'MOST_USED'; count: number; of: number };

export interface P2PSuggestion {
  categoryId: string;
  reason: SuggestionReason;
}

export function suggestP2PCategories(
  targets: P2PTarget[],
  history: P2PHistoryRow[],
  rules: RuleData[],
): Map<string, P2PSuggestion> {
  // Newest first within each payee+direction, so "the most recent" is index 0.
  const byPayee = new Map<string, P2PHistoryRow[]>();
  for (const h of history) {
    const key = payeeKey(h.description);
    if (key === '' || h.amount === 0) continue;
    const bucket = `${key}|${Math.sign(h.amount)}`;
    byPayee.set(bucket, [...(byPayee.get(bucket) ?? []), h]);
  }
  for (const rows of byPayee.values()) rows.sort((a, b) => b.date.getTime() - a.date.getTime());

  const out = new Map<string, P2PSuggestion>();
  for (const t of targets) {
    const key = payeeKey(t.description);
    const past = key === '' || t.amount === 0 ? [] : (byPayee.get(`${key}|${Math.sign(t.amount)}`) ?? []);

    const size = Math.abs(t.amount);
    const sameAmount = past.find((h) => Math.abs(Math.abs(h.amount) - size) <= size * AMOUNT_TOLERANCE);
    if (sameAmount !== undefined) {
      out.set(t.id, { categoryId: sameAmount.categoryId, reason: { kind: 'SAME_AMOUNT', date: sameAmount.date } });
      continue;
    }

    const rule = userCategoryRuleFor(rules, t);
    if (rule !== null && rule.setCategoryId !== null) {
      out.set(t.id, { categoryId: rule.setCategoryId, reason: { kind: 'RULE' } });
      continue;
    }

    if (past.length > 0) {
      const counts = new Map<string, number>();
      for (const h of past) counts.set(h.categoryId, (counts.get(h.categoryId) ?? 0) + 1);
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const [winner, top] = ranked[0];
      const runnerUp = ranked[1]?.[1] ?? 0;
      if (top >= MIN_FAVOURITE && top > runnerUp) {
        out.set(t.id, { categoryId: winner, reason: { kind: 'MOST_USED', count: top, of: past.length } });
      }
    }
  }
  return out;
}
