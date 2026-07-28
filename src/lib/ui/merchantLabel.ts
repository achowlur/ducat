import { payeeKey } from "../sync/grouping";
import { P2P_PATTERN } from "../sync/rules";
import { titleCase } from "./format";

/**
 * What a ledger row is actually FOR, and what a rule about it should match.
 *
 * These two answers are computed together because they must never disagree.
 * The row you read is the row you act on: showing "Fairley Robin" while the
 * rule button quietly writes `merchant contains "zelle transfer"` would
 * recategorize every Zelle payment the operator has ever made from a control
 * labelled with one person's name.
 *
 * For a P2P rail the bank's own payee field is useless — Wells Fargo reports
 * every one of 64 Zelle transactions as "ZELLE TRANSFER" — while the
 * counterparty is sitting in the description ("ZELLE TO FAIRLEY ROBIN ON 07/19
 * REF # ..."). The rail says nothing about what the money was for, which is
 * the whole reason P2P has to be reviewed by hand; hiding the one piece of
 * information that DOES distinguish two payments made it unreviewable.
 */
export interface MerchantLabel {
  /** What the ledger shows in the merchant column. */
  label: string;
  /** What a rule created from this row should match against. */
  ruleValue: string;
  ruleField: "MERCHANT" | "DESCRIPTION";
}

/** Shorter than this matches half the ledger — the grouped review's floor, for the same reason. */
const MIN_RULE_VALUE = 3;

/**
 * The rail and its direction word, which carry no information about WHO.
 * Measured against what remains, because a length check on the whole payee is
 * a floor in name only: "ZELLE 12345678" keys to "zelle", five characters that
 * pass any such test and match every P2P payment in the database.
 */
const RAIL_WORDS = /\b(to|from|payment|transfer|pmt)\b/g;

export function merchantLabel(t: { normalizedMerchant: string; description: string }): MerchantLabel {
  const merchant = t.normalizedMerchant.trim();
  const fallback: MerchantLabel = {
    label: titleCase(merchant !== "" ? merchant : t.description.toLowerCase()),
    ruleValue: merchant,
    ruleField: "MERCHANT",
  };

  const isP2P = P2P_PATTERN.test(t.normalizedMerchant) || P2P_PATTERN.test(t.description);
  if (!isP2P) return fallback;

  // The rail carries the counterparty in its description. `payeeKey` truncates
  // at the first reference marker rather than deleting one mid-string, so the
  // result stays a contiguous prefix of the description — which is what lets it
  // work as a DESCRIPTION rule's CONTAINS value.
  const payee = payeeKey(t.description);
  const named = payee
    .replace(P2P_PATTERN, " ")
    .replace(RAIL_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (named.length < MIN_RULE_VALUE) return fallback;

  return {
    label: titleCase(payee),
    ruleValue: payee,
    // DESCRIPTION, not MERCHANT: the payee appears in the description and never
    // in the merchant, which is the generic rail. A MERCHANT rule built from it
    // would match nothing at all.
    ruleField: "DESCRIPTION",
  };
}
