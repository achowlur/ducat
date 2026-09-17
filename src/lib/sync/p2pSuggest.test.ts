import { describe, expect, it } from "vitest";
import { suggestP2PCategories, type P2PHistoryRow, type P2PTarget } from "./p2pSuggest";
import type { RuleData } from "./rules";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

// Invented payees and amounts throughout.
const target = (partial: Partial<P2PTarget>): P2PTarget => ({
  id: "t-new",
  amount: -1200,
  date: utc(2026, 9, 1),
  description: "ZELLE TO JANE DOE ON 09/01 REF # WFCT0000000A",
  normalizedMerchant: "zelle to jane doe",
  accountName: "Checking",
  categorySource: "AGGREGATOR",
  ...partial,
});

const past = (partial: Partial<P2PHistoryRow> & { categoryId: string; date: Date }): P2PHistoryRow => ({
  amount: -1200,
  description: "ZELLE TO JANE DOE ON 08/01 REF # WFCT0000000B",
  ...partial,
});

const payeeRule = (setCategoryId: string): RuleData => ({
  id: "r-jane",
  priority: 50,
  matchField: "DESCRIPTION",
  matchOperator: "CONTAINS",
  matchValue: "zelle to jane doe",
  setCategoryId,
  setFlow: null,
  enabled: true,
});

describe("suggestP2PCategories", () => {
  it("prefers a past payment to the same person for the same amount, naming its date", () => {
    const s = suggestP2PCategories(
      [target({})],
      [
        past({ categoryId: "cat-dining", amount: -40, date: utc(2026, 8, 20) }),
        past({ categoryId: "cat-rent", amount: -1230, date: utc(2026, 8, 1) }), // within 5%
      ],
      [payeeRule("cat-gifts")],
    ).get("t-new");
    expect(s).toEqual({ categoryId: "cat-rent", reason: { kind: "SAME_AMOUNT", date: utc(2026, 8, 1) } });
  });

  it("takes the MOST RECENT same-amount payment when there are several", () => {
    const s = suggestP2PCategories(
      [target({})],
      [
        past({ categoryId: "cat-rent", date: utc(2026, 7, 1) }),
        past({ categoryId: "cat-utilities", date: utc(2026, 8, 1) }),
      ],
      [],
    ).get("t-new");
    expect(s?.categoryId).toBe("cat-utilities");
  });

  it("does not call an amount 6% away the same payment", () => {
    const history = [
      past({ categoryId: "cat-rent", amount: -1272, date: utc(2026, 8, 1) }),
      past({ categoryId: "cat-rent", amount: -1290, date: utc(2026, 7, 1) }),
    ];
    const s = suggestP2PCategories([target({})], history, []).get("t-new");
    expect(s?.reason.kind).toBe("MOST_USED"); // still that person's category, on weaker evidence
  });

  it("falls back to the payee's rule when no amount matches", () => {
    const s = suggestP2PCategories([target({})], [past({ categoryId: "cat-dining", amount: -40, date: utc(2026, 8, 20) })], [
      payeeRule("cat-rent"),
    ]).get("t-new");
    expect(s).toEqual({ categoryId: "cat-rent", reason: { kind: "RULE" } });
  });

  it("then to the payee's clear favourite category", () => {
    const history = [
      past({ categoryId: "cat-dining", amount: -40, date: utc(2026, 6, 1) }),
      past({ categoryId: "cat-gifts", amount: -75, date: utc(2026, 7, 1) }),
      past({ categoryId: "cat-dining", amount: -35, date: utc(2026, 7, 15) }),
    ];
    const s = suggestP2PCategories([target({})], history, []).get("t-new");
    expect(s).toEqual({ categoryId: "cat-dining", reason: { kind: "MOST_USED", count: 2, of: 3 } });
  });

  it("suggests nothing from a tie or a single past payment — that is a guess, not evidence", () => {
    const tie = [
      past({ categoryId: "cat-dining", amount: -40, date: utc(2026, 6, 1) }),
      past({ categoryId: "cat-gifts", amount: -75, date: utc(2026, 7, 1) }),
      past({ categoryId: "cat-dining", amount: -35, date: utc(2026, 7, 15) }),
      past({ categoryId: "cat-gifts", amount: -60, date: utc(2026, 8, 1) }),
    ];
    expect(suggestP2PCategories([target({})], tie, []).size).toBe(0);
    const once = [past({ categoryId: "cat-dining", amount: -40, date: utc(2026, 6, 1) })];
    expect(suggestP2PCategories([target({})], once, []).size).toBe(0);
  });

  it("keeps money IN and money OUT apart — a friend repaying you is not what you pay them for", () => {
    // Same description both ways, as Venmo writes it, so only the SIGN differs.
    const venmo = "VENMO PAYMENT 1000000001 JANE DOE";
    const history = [past({ categoryId: "cat-rent", amount: -1200, description: venmo, date: utc(2026, 8, 1) })];
    const incoming = target({ amount: 1200, description: venmo, normalizedMerchant: "venmo payment" });
    expect(suggestP2PCategories([incoming], history, []).size).toBe(0);
    const outgoing = target({ amount: -1200, description: venmo, normalizedMerchant: "venmo payment" });
    expect(suggestP2PCategories([outgoing], history, []).get("t-new")?.categoryId).toBe("cat-rent");
  });

  it("tells two people apart on the same rail", () => {
    const history = [past({ categoryId: "cat-rent", date: utc(2026, 8, 1) })];
    const other = target({ description: "ZELLE TO SAM ROE ON 09/01", normalizedMerchant: "zelle to sam roe" });
    expect(suggestP2PCategories([other], history, []).size).toBe(0);
  });

  it("offers nothing without evidence, rather than guessing", () => {
    expect(suggestP2PCategories([target({})], [], []).size).toBe(0);
  });
});
