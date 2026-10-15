import { beyondRail, keysOnDescription, MIN_PAYEE_NAME, payeeKey } from "../sync/grouping";
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

export function merchantLabel(t: { normalizedMerchant: string; description: string }): MerchantLabel {
  const merchant = t.normalizedMerchant.trim();
  const fallback: MerchantLabel = {
    label: titleCase(merchant !== "" ? merchant : t.description.toLowerCase()),
    ruleValue: merchant,
    ruleField: "MERCHANT",
  };

  // The grouped review's own test, so the row you read and the group you
  // decide on name the same payee: a card-network payment keys on its merchant.
  const isP2P = P2P_PATTERN.test(t.normalizedMerchant) || P2P_PATTERN.test(t.description);
  if (!isP2P || !keysOnDescription(t)) return fallback;

  // The rail carries the counterparty in its description. `payeeKey` truncates
  // at the first reference marker rather than deleting one mid-string, so the
  // result stays a contiguous prefix of the description — which is what lets it
  // work as a DESCRIPTION rule's CONTAINS value.
  const payee = payeeKey(t.description);
  if (beyondRail(payee).length < MIN_PAYEE_NAME) return fallback;

  return {
    label: titleCase(payee),
    ruleValue: payee,
    // DESCRIPTION, not MERCHANT: the payee appears in the description and never
    // in the merchant, which is the generic rail. A MERCHANT rule built from it
    // would match nothing at all.
    ruleField: "DESCRIPTION",
  };
}

/**
 * What /trends totals a merchant BY, and what the ledger's `?merchant=` matches
 * exactly: the label's own rule value, so rows sharing a key share the name the
 * ledger prints and a merchant's total is the total of the rows shown under it.
 * A P2P row keys on its payee, never the rail, or every Zelle payment would be
 * one merchant. A row with no merchant at all keys on its description, which
 * is what its label prints.
 */
export function merchantKey(t: { normalizedMerchant: string; description: string }): string {
  const { ruleValue } = merchantLabel(t);
  return ruleValue !== "" ? ruleValue : t.description.toLowerCase().replace(/\s+/g, " ").trim();
}
