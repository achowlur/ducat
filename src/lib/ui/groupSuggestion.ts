import type { GroupReason } from "../sync/groupSuggest";
import { money, shortDate, titleCase } from "./format";

/**
 * Why a payee's category was suggested, in the words the review queue shows
 * under it: short enough for one line on a phone, and naming the evidence so
 * a wrong suggestion is caught by reading it, not by applying it.
 */
export function groupReasonText(reason: GroupReason): string {
  switch (reason.kind) {
    case "BEFORE":
      return reason.count === 1 ? "as you filed it before" : `as you filed it ${reason.count} times before`;
    case "TWIN":
      return `like ${titleCase(reason.like)}`;
    case "WORDING":
      return `money in, described as ${reason.what}`;
    case "MONTHLY":
      return `${money(reason.amount)} every month`;
    case "MEMO":
      return `the memo says "${reason.word}"`;
    case "P2P":
      return reason.reason.kind === "SAME_AMOUNT"
        ? `same amount as ${shortDate(reason.reason.date)}`
        : reason.reason.kind === "RULE"
          ? "your rule for this payee"
          : `${reason.reason.count} of ${reason.reason.of} past payments`;
    case "SHARED_WORD":
      return `shares "${reason.word}" with ${titleCase(reason.like)}`;
  }
}
