/**
 * An investment account is a CLOSED BOX: nothing that happens inside one is
 * income or spending. Money counts when it reaches a bank account, and not
 * before.
 *
 * Cash flow is "every inflow that is not a transfer is income, every outflow
 * that is not a transfer is spending", and it never asked what KIND of account
 * a row sat in. So a sale of shares was income, the purchase it paid for was
 * spending, and a dividend was income the day it was declared whether or not
 * it ever left the brokerage. An instance with an active brokerage account
 * could have most of its "income" rows inside it.
 *
 * The Fidelity CSV mapping has always flagged trades TRANSFER at import, by
 * wording. The live feed had two phrases (`reinvestment`, `purchase into core
 * account`), so the same trade was a transfer from a file and income from the
 * feed. Wording cannot close that gap: a 401(k) reports contributions and loan
 * repayments with a fund name for a description and no verb at all.
 *
 * So the classification is by ACCOUNT TYPE, and it is written as TRANSFER, the
 * flag every screen and analyzer already honours. What an investment account
 * earns is not lost by this: it is the market-movement figure, which has
 * always been computed from balances and never from these rows.
 *
 * Pure on purpose. The writes that use it are in rulePack.ts.
 */
import { INTERNAL_INVESTMENT_ACTIVITY } from '../insights/netWorth';

/** What an application carries as its rule when no stored rule made it. */
export const CLOSED_BOX_RULE_ID = 'structural:closed-box';

const CLOSED_BOX_TYPES = new Set(['INVESTMENT']);

export function isClosedBox(accountType: string | null | undefined): boolean {
  return accountType !== null && accountType !== undefined && CLOSED_BOX_TYPES.has(accountType);
}

/**
 * Whether a row in a closed box could be one side of a movement ACROSS its
 * edge: a deposit from a bank account, a withdrawal to one.
 *
 * Transfer pairing needs these, or the bank's side of a brokerage deposit
 * finds nothing to pair with and is counted as spending. It must NOT be
 * offered the rest: a sale or a dividend of exactly some amount, within four
 * days of an unrelated bill of the same amount, would pair with the bill and
 * hide it.
 *
 * Decided by exclusion, exactly as the net-worth flows are and with the same
 * pattern: the verbs for staying inside are few and stable, the descriptors
 * for crossing vary by institution, and anything unrecognised is treated as a
 * crossing.
 */
export function crossesTheBoundary(description: string): boolean {
  return !INTERNAL_INVESTMENT_ACTIVITY.test(description);
}

/**
 * What a row becomes when a person CLEARS its category.
 *
 * Clearing hands the row back to the rules, and inside a closed box the
 * first of those is the box. Without this a row cleared in an investment
 * account sat uncategorized and counted, as income or as spending, until
 * something happened to reapply: the one way to release a hand-categorized
 * row from the totals would have put it straight back into them.
 */
export function whenCleared(
  accountType: string | null | undefined,
): { categoryId: null; categorySource: 'AGGREGATOR' } | { categoryId: null; categorySource: 'RULE'; flow: 'TRANSFER' } {
  return isClosedBox(accountType)
    ? { categoryId: null, categorySource: 'RULE', flow: 'TRANSFER' }
    : { categoryId: null, categorySource: 'AGGREGATOR' };
}

/** The flow a row has by its own amount, before anything classified it. */
export function flowByAmount(amount: number): 'INFLOW' | 'OUTFLOW' {
  return amount >= 0 ? 'INFLOW' : 'OUTFLOW';
}
