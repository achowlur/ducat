import { describe, expect, it } from "vitest";
import { skeleton, suggestGroupCategories, type HistoryRow, type SuggestGroup, type SuggestRow } from "./groupSuggest";

const day = (m: number, d: number) => new Date(Date.UTC(2026, m - 1, d, 12));
const ids = new Map([
  ["Dining", "c-dining"],
  ["Groceries", "c-groceries"],
  ["Income", "c-income"],
  ["Subscriptions", "c-subs"],
  ["Health", "c-health"],
]);

let n = 0;
const row = (merchant: string, amount = -12, date = day(3, 1), description = merchant.toUpperCase()): SuggestRow => ({
  id: `r${++n}`,
  amount,
  date,
  description,
  normalizedMerchant: merchant,
});
const group = (key: string, rows: SuggestRow[], isP2P = false): SuggestGroup => ({ key, isP2P, rows });
const past = (merchant: string, categoryId: string, extra: Partial<HistoryRow> = {}): HistoryRow => ({
  amount: -10,
  date: day(1, 5),
  description: merchant.toUpperCase(),
  normalizedMerchant: merchant,
  categoryId,
  isP2P: false,
  ...extra,
});

const suggest = (groups: SuggestGroup[], history: HistoryRow[]) => suggestGroupCategories(groups, history, [], ids);

describe("skeleton", () => {
  it("meets two spellings of one store", () => {
    expect(skeleton("marigold cafe llc")).toBe(skeleton("marigold cafe,llc"));
    expect(skeleton("0412 marigold cafe")).toBe(skeleton("marigold cafe 0412"));
  });

  it("has nothing to say about the bank's own bookkeeping or a scrap of a name", () => {
    expect(skeleton("purchase authorized on 03/14 marigold")).toBeNull();
    expect(skeleton("abc 123")).toBeNull();
  });
});

describe("suggestGroupCategories", () => {
  it("suggests what the operator filed this same payee as before", () => {
    const s = suggest([group("marigold cafe", [row("marigold cafe")])], [past("marigold cafe", "c-dining"), past("marigold cafe", "c-dining")]);
    expect(s.get("marigold cafe")).toEqual({ categoryId: "c-dining", reason: { kind: "BEFORE", count: 2 }, strength: "strong" });
  });

  it("suggests the category of the same payee spelled another way", () => {
    const s = suggest([group("marigold cafe,llc", [row("marigold cafe,llc")])], [past("marigold cafe llc", "c-dining")]);
    expect(s.get("marigold cafe,llc")).toMatchObject({ categoryId: "c-dining", reason: { kind: "TWIN", like: "marigold cafe llc" }, strength: "strong" });
  });

  it("files money in worded as interest or a deposit as Income, and only money in", () => {
    const s = suggest(
      [
        group("interest payment", [row("interest payment", 4.12)]),
        group("mobile deposit", [row("mobile deposit", 250, day(3, 2), "MOBILE DEPOSIT REF 0000")]),
        group("loan interest payment", [row("loan interest payment", -80, day(3, 3), "LOAN INTEREST PAYMENT")]),
      ],
      [],
    );
    expect(s.get("interest payment")).toMatchObject({ categoryId: "c-income", reason: { kind: "WORDING", what: "interest" } });
    expect(s.get("mobile deposit")).toMatchObject({ categoryId: "c-income", reason: { kind: "WORDING", what: "a deposit" } });
    expect(s.get("loan interest payment")).toBeUndefined();
  });

  it("files the same amount every month as Subscriptions", () => {
    const rows = [day(1, 9), day(2, 9), day(3, 9)].map((d) => row("tinyapp", -7.99, d));
    expect(suggest([group("tinyapp", rows)], []).get("tinyapp")).toMatchObject({
      categoryId: "c-subs",
      reason: { kind: "MONTHLY", amount: 7.99 },
    });
  });

  it("does not call irregular charges a subscription", () => {
    const rows = [day(1, 9), day(1, 20), day(3, 9)].map((d) => row("tinyapp", -7.99, d));
    expect(suggest([group("tinyapp", rows)], []).get("tinyapp")).toBeUndefined();
  });

  it("reads a P2P memo with the pack's generic words", () => {
    const p2p = row("zelle transfer", -18, day(3, 4), "ZELLE TO LENA ON 03/04 REF # WFCT0000000A PIZZA NIGHT");
    expect(suggest([group("zelle to lena", [p2p], true)], []).get("zelle to lena")).toMatchObject({
      categoryId: "c-dining",
      reason: { kind: "MEMO", word: "pizza" },
      strength: "strong",
    });
  });

  it("offers a person's past payments only as a guess", () => {
    const waiting = row("zelle transfer", -40, day(3, 4), "ZELLE TO LENA ON 03/04 REF # WFCT0000000B");
    const history: HistoryRow[] = [day(1, 4), day(2, 4)].map((d) => ({
      amount: -40,
      date: d,
      description: "ZELLE TO LENA ON 01/04 REF # WFCT0000000C",
      normalizedMerchant: "zelle transfer",
      categoryId: "c-groceries",
      isP2P: true,
    }));
    expect(suggest([group("zelle to lena", [waiting], true)], history).get("zelle to lena")).toMatchObject({
      categoryId: "c-groceries",
      strength: "guess",
      reason: { kind: "P2P" },
    });
  });

  it("never matches a person to another payee by spelling or by a shared word", () => {
    const p2p = row("zelle transfer", -18, day(3, 4), "ZELLE TO MARIGOLD JONES ON 03/04 REF # WFCT0000000A");
    const s = suggest([group("zelle to marigold jones", [p2p], true)], [past("marigold cafe", "c-dining")]);
    expect(s.get("zelle to marigold jones")).toBeUndefined();
  });

  it("offers a shared distinctive word only as a guess", () => {
    const s = suggest([group("riverside bakehouse", [row("riverside bakehouse")])], [past("bakehouse on main", "c-dining")]);
    expect(s.get("riverside bakehouse")).toMatchObject({ categoryId: "c-dining", strength: "guess", reason: { kind: "SHARED_WORD", word: "bakehouse" } });
  });

  it("guesses nothing from a word its payees disagree on, or from a word too common to mean anything", () => {
    const split = suggest([group("harbor goods", [row("harbor goods")])], [past("harbor diner", "c-dining"), past("harbor clinic", "c-health")]);
    expect(split.get("harbor goods")).toBeUndefined();
    const common = suggest(
      [group("main street goods", [row("main street goods")])],
      ["a", "b", "c", "d"].map((x) => past(`main street ${x}xxx`, "c-dining")),
    );
    expect(common.get("main street goods")).toBeUndefined();
  });

  it("suggests nothing on a tie between the payee's own past categories", () => {
    const s = suggest([group("marigold cafe", [row("marigold cafe")])], [past("marigold cafe", "c-dining"), past("marigold cafe", "c-groceries")]);
    expect(s.get("marigold cafe")).toBeUndefined();
  });
});
