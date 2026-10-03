import {
  COMPARE_KEYS,
  EXPLORE_SPAN_KEYS,
  MONTH_KEY,
  type CompareKey,
  type GroupBy,
  type GroupTarget,
  type Measure,
} from "./report";

/**
 * /trends' questions, read from the URL, owned here. Every card keeps its own
 * parameters under its own prefix (`b.by`, `e.over`), so changing one card
 * never moves another, and a parameter at its default is simply absent.
 *
 * A card's chart choice ("view as") is read from the URL first and then from
 * a cookie the switch writes, so a card opens on the chart its reader last
 * chose. Either is checked against the views the data's SHAPE allows: a
 * remembered pie must not be honoured for months.
 */

export const A_VIEWS = [
  { value: "running", label: "Running total" },
  { value: "daily", label: "Each day" },
  { value: "table", label: "Table" },
] as const;
export const B_VIEWS = [
  { value: "change", label: "Change" },
  { value: "side", label: "Side by side" },
  { value: "table", label: "Table" },
] as const;
/** One series over months: never a pie, months are not parts of a whole. */
export const E_MONTH_VIEWS = [
  { value: "bars", label: "Bars" },
  { value: "line", label: "Line" },
  { value: "table", label: "Table" },
] as const;
/** Groups over a span: parts of a whole as bars, pie or table, or each group across the months. */
export const E_GROUP_VIEWS = [
  { value: "bars", label: "Bars" },
  { value: "pie", label: "Pie" },
  { value: "lines", label: "Lines" },
  { value: "stacked", label: "Stacked" },
  { value: "table", label: "Table" },
] as const;

type ValueOf<T extends readonly { value: string }[]> = T[number]["value"];
export type AView = ValueOf<typeof A_VIEWS>;
export type BView = ValueOf<typeof B_VIEWS>;
export type EMonthView = ValueOf<typeof E_MONTH_VIEWS>;
export type EGroupView = ValueOf<typeof E_GROUP_VIEWS>;

export type ExploreBy = "month" | GroupBy;
export type ExploreShow = Measure | "both";

export interface TrendsParams {
  a: { view: AView };
  b: { view: BView; span: CompareKey; by: GroupBy; show: Measure };
  /** `over` is a preset (report.ts EXPLORE_SPAN_KEYS) or one month's key. */
  e: { view: string; show: ExploreShow; by: ExploreBy; for: GroupTarget | null; over: string };
}

export type RawSearch = Record<string, string | string[] | undefined>;

const GROUP_BYS: readonly GroupBy[] = ["category", "merchant", "account"];
const MEASURES: readonly Measure[] = ["spending", "income"];

function first(raw: RawSearch, name: string): string | undefined {
  const v = raw[name];
  return Array.isArray(v) ? v[0] : v;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value !== undefined && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function viewOf<T extends string>(
  card: string,
  raw: RawSearch,
  cookie: (name: string) => string | undefined,
  options: readonly { value: T }[],
): T {
  const allowed = options.map((o) => o.value);
  const fromUrl = first(raw, `${card}.view`);
  if (fromUrl !== undefined && (allowed as string[]).includes(fromUrl)) return fromUrl as T;
  return oneOf(cookie(`trends.${card}`), allowed, allowed[0]);
}

/** `category:<id>`, `account:<id>` or `merchant:<key>`; anything else is no filter. */
export function parseTarget(raw: string | undefined): GroupTarget | null {
  if (raw === undefined) return null;
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const by = raw.slice(0, at);
  const key = raw.slice(at + 1);
  if (key === "" || !(GROUP_BYS as readonly string[]).includes(by)) return null;
  return { by: by as GroupBy, key };
}

export function targetParam(t: GroupTarget): string {
  return `${t.by}:${t.key}`;
}

export function parseTrendsParams(raw: RawSearch, cookie: (name: string) => string | undefined): TrendsParams {
  const eBy = oneOf<ExploreBy>(first(raw, "e.by"), ["month", ...GROUP_BYS], "month");
  // "Income and spending" is two series over months; across groups it would
  // be two different wholes, so it is offered only by month.
  const eShow = oneOf<ExploreShow>(first(raw, "e.show"), eBy === "month" ? ["spending", "income", "both"] : MEASURES, "spending");
  return {
    a: { view: viewOf("a", raw, cookie, A_VIEWS) },
    b: {
      view: viewOf("b", raw, cookie, B_VIEWS),
      span: oneOf(first(raw, "b.span"), COMPARE_KEYS, "1m"),
      by: oneOf(first(raw, "b.by"), GROUP_BYS, "category"),
      show: oneOf(first(raw, "b.show"), MEASURES, "spending"),
    },
    e: {
      view: viewOf("e", raw, cookie, eBy === "month" ? E_MONTH_VIEWS : E_GROUP_VIEWS),
      show: eShow,
      by: eBy,
      for: parseTarget(first(raw, "e.for")),
      over: MONTH_KEY.test(first(raw, "e.over") ?? "")
        ? (first(raw, "e.over") as string)
        : oneOf(first(raw, "e.over"), EXPLORE_SPAN_KEYS, "12m"),
    },
  };
}
