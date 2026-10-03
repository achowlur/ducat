import { periodKey } from "../insights/periods";
import { isReimbursement, reimbursementSources } from "../insights/reimbursements";
import type { TxnData } from "../insights/types";
import { isUnreviewedP2P, P2P_UNREVIEWED_ID, P2P_UNREVIEWED_NAME } from "../p2p";
import { UNCATEGORIZED } from "./categoryFilter";
import { merchantKey, merchantLabel } from "./merchantLabel";
import { spanLabel, spanParam } from "./periodSpan";

/**
 * The figures /trends draws, computed from TRANSACTIONS rather than stored
 * insight rows, because its questions cross the insight grid: twelve months
 * against twelve, one merchant, one card, one day of the month.
 *
 * Every figure is a sum over ENTRIES, and an entry carries the analyzers'
 * semantics so the two cannot drift (report.test.ts pins month totals to
 * computeSpendingByCategory and computeCashFlowTrend):
 * - an OUTFLOW is spending, a TRANSFER is nothing;
 * - an INFLOW that reimburses (insights/reimbursements.ts) is a NEGATIVE
 *   spending entry filed under the row it nets against: the linked bill's
 *   category, month, merchant and account, or its own when unlinked;
 * - any other INFLOW is income;
 * - an unconfirmed P2P outflow files under "P2P — Unreviewed", before
 *   credits resolve, exactly as computeSpendingByCategory relabels it.
 *
 * Amounts are summed in whole CENTS: a twelve-month span adds a few thousand
 * rows, and float addition drifts on that many.
 */

export type Measure = "spending" | "income";
export type GroupBy = "category" | "merchant" | "account";

/** The `?category=` token for the Uncategorized bucket, owned by ui/categoryFilter.ts. */
export const UNCATEGORIZED_KEY = UNCATEGORIZED;

export interface Entry {
  /** "2026-07", UTC like every period key. */
  month: string;
  /** UTC day of the month, 1-31. */
  day: number;
  measure: Measure;
  /** Spending: positive spent, negative credited. Income: positive received. */
  cents: number;
  categoryId: string | null;
  categoryName: string | null;
  /** ui/merchantLabel.ts's merchantKey, and the label the ledger prints for it. */
  merchant: string;
  merchantName: string;
  accountId: string;
}

export interface Span {
  /** First month, inclusive. */
  from: string;
  /** Last month, inclusive. */
  to: string;
}

const toDollars = (cents: number) => cents / 100;

export function buildEntries(txns: TxnData[]): Entry[] {
  const relabeled = txns.map((t) =>
    t.flow === "OUTFLOW" && isUnreviewedP2P(t)
      ? { ...t, categoryId: P2P_UNREVIEWED_ID, categoryName: P2P_UNREVIEWED_NAME }
      : t,
  );
  const merchants = new Map<string, { key: string; label: string }>();
  const merchantOf = (t: TxnData) => {
    let m = merchants.get(t.id);
    if (m === undefined) {
      m = { key: merchantKey(t), label: merchantLabel(t).label };
      merchants.set(t.id, m);
    }
    return m;
  };
  const entry = (
    t: TxnData,
    measure: Measure,
    value: number,
    category: { id: string | null; name: string | null } = { id: t.categoryId, name: t.categoryName },
  ): Entry => {
    const m = merchantOf(t);
    return {
      month: periodKey(t.date, "MONTH"),
      day: t.date.getUTCDate(),
      measure,
      cents: Math.round(value * 100),
      categoryId: category.id,
      categoryName: category.name,
      merchant: m.key,
      merchantName: m.label,
      accountId: t.accountId,
    };
  };

  const entries: Entry[] = [];
  for (const t of relabeled) {
    if (t.flow === "OUTFLOW") {
      entries.push(entry(t, "spending", -t.amount));
    } else if (t.flow === "INFLOW" && !isReimbursement(t)) {
      // Unconfirmed money IN is income, and groups under the P2P bucket's
      // name so its ledger link lists exactly those rows. Relabelled HERE,
      // after isReimbursement has read the real (absent) category: giving it a
      // category first would have made it a credit.
      entries.push(
        isUnreviewedP2P(t)
          ? entry(t, "income", t.amount, { id: P2P_UNREVIEWED_ID, name: P2P_UNREVIEWED_NAME })
          : entry(t, "income", t.amount),
      );
    }
  }
  for (const { source, amount } of reimbursementSources(relabeled)) {
    entries.push(entry(source, "spending", -amount));
  }
  return entries;
}

// ---------------------------------------------------------------- months

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  return periodKey(new Date(Date.UTC(y, m - 1 + n, 1)), "MONTH");
}

export function monthsOf(span: Span): string[] {
  const months: string[] = [];
  for (let k = span.from; k <= span.to; k = addMonths(k, 1)) months.push(k);
  return months;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The month before the one being lived in: the newest month with all its days. */
export function lastCompleteMonth(now: Date): string {
  return addMonths(periodKey(now, "MONTH"), -1);
}

/** The earliest month holding any entry; null for an empty ledger. */
export function firstMonth(entries: Entry[]): string | null {
  let first: string | null = null;
  for (const e of entries) if (first === null || e.month < first) first = e.month;
  return first;
}

/** Cents per month for one measure, every month present (zero when empty). */
function byMonth(entries: Entry[], measure: Measure, keep: (e: Entry) => boolean = () => true): Map<string, number> {
  const totals = new Map<string, number>();
  for (const e of entries) {
    if (e.measure !== measure || !keep(e)) continue;
    totals.set(e.month, (totals.get(e.month) ?? 0) + e.cents);
  }
  return totals;
}

// ---------------------------------------------------------------- groups

export interface GroupTarget {
  by: GroupBy;
  key: string;
}

export function groupKey(e: Entry, by: GroupBy): string {
  switch (by) {
    case "category":
      return e.categoryId ?? UNCATEGORIZED_KEY;
    case "merchant":
      return e.merchant;
    case "account":
      return e.accountId;
  }
}

function groupLabel(e: Entry, by: GroupBy, accountNames: ReadonlyMap<string, string>): string {
  switch (by) {
    case "category":
      return e.categoryName ?? "Uncategorized";
    case "merchant":
      return e.merchantName;
    case "account":
      return accountNames.get(e.accountId) ?? "Unknown account";
  }
}

export function matches(e: Entry, target: GroupTarget | null): boolean {
  return target === null || groupKey(e, target.by) === target.key;
}

/**
 * The ledger view behind a figure: the same months, the same group. Spending
 * opens every flow, because the figure is NET of the refunds and repayments
 * that view shows (its REPAID covers repayments filed elsewhere); income opens
 * money in only.
 */
export function ledgerHref(targets: (GroupTarget | null)[], span: Span, measure: Measure): string {
  const q = new URLSearchParams();
  q.set("period", spanParam(span.from, span.to));
  for (const target of targets) {
    if (target === null) continue;
    if (target.by === "category") q.set("category", target.key);
    else if (target.by === "account") q.set("account", target.key);
    else q.set("merchant", target.key);
  }
  if (measure === "income") q.set("flow", "INFLOW");
  return `/transactions?${q.toString()}`;
}

// ---------------------------------------------------------------- A: the month so far

export interface MonthSoFar {
  month: string;
  previous: string;
  /** Today's day of the month, the last point the current line reaches. */
  today: number;
  /** Days in the current month: the axis. */
  days: number;
  /** Running spending, days 1..today. */
  current: number[];
  /** Running spending last month, days 1..days, flat past its own last day. */
  last: number[];
  /** Spending on each day: current 1..today, last 1..days. */
  currentDaily: number[];
  lastDaily: number[];
  /**
   * The middle half (25th to 75th percentile) of the recent complete months'
   * running totals at each day; null with fewer than BAND_MIN_MONTHS of them.
   */
  band: { low: number[]; high: number[]; months: string[] } | null;
  /** The newest day anything is recorded on, which trails today while transactions post. */
  newest: { month: string; day: number } | null;
}

/** How many complete months the typical band looks back over, and the fewest it is drawn from. */
export const BAND_MONTHS = 6;
export const BAND_MIN_MONTHS = 3;

/** Linear-interpolated quantile of a sorted list (the common "type 7"). */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function monthSoFar(entries: Entry[], now: Date): MonthSoFar {
  const month = periodKey(now, "MONTH");
  const previous = addMonths(month, -1);
  const today = now.getUTCDate();
  const days = daysInMonth(month);

  const dailyCents = new Map<string, number[]>();
  for (const e of entries) {
    if (e.measure !== "spending") continue;
    let d = dailyCents.get(e.month);
    if (d === undefined) {
      d = new Array<number>(31).fill(0);
      dailyCents.set(e.month, d);
    }
    d[e.day - 1] += e.cents;
  }
  const daily = (key: string, n: number) => (dailyCents.get(key) ?? new Array<number>(31).fill(0)).slice(0, n);
  const running = (key: string, n: number) => {
    let sum = 0;
    return daily(key, n).map((c) => (sum += c));
  };

  // A month with no spending at all is a month with no records, not a month
  // that cost nothing: it joins no band.
  const recent: string[] = [];
  for (let back = 1; back <= BAND_MONTHS; back += 1) {
    const key = addMonths(month, -back);
    if (dailyCents.has(key)) recent.push(key);
  }
  let band: MonthSoFar["band"] = null;
  if (recent.length >= BAND_MIN_MONTHS) {
    const runs = recent.map((key) => running(key, days));
    const low: number[] = [];
    const high: number[] = [];
    for (let d = 0; d < days; d += 1) {
      const at = runs.map((r) => r[d]).sort((a, b) => a - b);
      low.push(Math.round(quantile(at, 0.25)) / 100);
      high.push(Math.round(quantile(at, 0.75)) / 100);
    }
    band = { low, high, months: recent.reverse() };
  }

  let newest: MonthSoFar["newest"] = null;
  for (const e of entries) {
    if (newest === null || e.month > newest.month || (e.month === newest.month && e.day > newest.day)) {
      newest = { month: e.month, day: e.day };
    }
  }

  return {
    month,
    previous,
    today,
    days,
    newest,
    current: running(month, today).map(toDollars),
    last: running(previous, days).map(toDollars),
    currentDaily: daily(month, today).map(toDollars),
    lastDaily: daily(previous, days).map(toDollars),
    band,
  };
}

// ---------------------------------------------------------------- B: what changed

export type CompareKey = "1m" | "mtd" | "3m" | "12m" | "ytd";
export const COMPARE_KEYS: readonly CompareKey[] = ["1m", "mtd", "3m", "12m", "ytd"];

export interface CompareSpans {
  current: Span;
  prior: Span;
  /** Both spans stop at this day of the month; null for whole months. */
  throughDay: number | null;
}

/**
 * Whole months compare COMPLETE months: one that includes the month being
 * lived in sets three days against thirty-one. The one exception says so in
 * its name: "this month so far" stops LAST month at the same day, which is
 * what makes the two comparable. In January, before the year has a complete
 * month, "this year so far" compares the whole of last year.
 */
export function compareSpans(key: CompareKey, now: Date): CompareSpans {
  const month = periodKey(now, "MONTH");
  const last = addMonths(month, -1);
  const run = (n: number) => ({
    current: { from: addMonths(last, -(n - 1)), to: last },
    prior: { from: addMonths(last, -(2 * n - 1)), to: addMonths(last, -n) },
    throughDay: null,
  });
  switch (key) {
    case "1m":
      return run(1);
    case "mtd":
      return { current: { from: month, to: month }, prior: { from: last, to: last }, throughDay: now.getUTCDate() };
    case "3m":
      return run(3);
    case "12m":
      return run(12);
    case "ytd": {
      const year = last.slice(0, 4);
      return {
        current: { from: `${year}-01`, to: last },
        prior: { from: `${Number(year) - 1}-01`, to: addMonths(last, -12) },
        throughDay: null,
      };
    }
  }
}

export interface ChangeRow {
  key: string;
  label: string;
  current: number;
  prior: number;
  change: number;
  href: string;
}

export interface Comparison {
  spans: CompareSpans;
  /** What moved most first, up or down: the question is what CHANGED. */
  rows: ChangeRow[];
  /** Groups past the row cap, summed into one row so the rows still add up to the total. */
  rest: { count: number; current: number; prior: number; change: number } | null;
  total: { current: number; prior: number; change: number };
  /** Months of the prior span before the first recorded month: its total is short by them. */
  priorMonthsMissing: number;
}

/** Merchants run to hundreds; the change view names this many and sums the rest. */
export const MERCHANT_ROWS = 12;

export function compare(
  entries: Entry[],
  measure: Measure,
  by: GroupBy,
  spans: CompareSpans,
  accountNames: ReadonlyMap<string, string>,
): Comparison {
  const inSpan = (m: string, s: Span) => m >= s.from && m <= s.to;
  const groups = new Map<string, { label: string; current: number; prior: number }>();
  let current = 0;
  let prior = 0;
  for (const e of entries) {
    if (e.measure !== measure) continue;
    if (spans.throughDay !== null && e.day > spans.throughDay) continue;
    const isCurrent = inSpan(e.month, spans.current);
    const isPrior = inSpan(e.month, spans.prior);
    if (!isCurrent && !isPrior) continue;
    const key = groupKey(e, by);
    let g = groups.get(key);
    if (g === undefined) {
      g = { label: groupLabel(e, by, accountNames), current: 0, prior: 0 };
      groups.set(key, g);
    }
    if (isCurrent) {
      g.current += e.cents;
      current += e.cents;
    } else {
      g.prior += e.cents;
      prior += e.cents;
    }
  }

  let rows = [...groups.entries()]
    .filter(([, g]) => g.current !== 0 || g.prior !== 0)
    .map(([key, g]) => ({ key, label: g.label, current: g.current, prior: g.prior, change: g.current - g.prior }));

  let rest: Comparison["rest"] = null;
  const cap = by === "merchant" ? MERCHANT_ROWS : Infinity;
  if (rows.length > cap) {
    // The rows that MOVED most, up or down, earn a name.
    const ranked = [...rows].sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.label.localeCompare(b.label));
    const folded = ranked.slice(cap);
    rows = ranked.slice(0, cap);
    const sum = (f: (r: (typeof folded)[number]) => number) => folded.reduce((s, r) => s + f(r), 0);
    rest = {
      count: folded.length,
      current: toDollars(sum((r) => r.current)),
      prior: toDollars(sum((r) => r.prior)),
      change: toDollars(sum((r) => r.change)),
    };
  }

  const first = firstMonth(entries);
  return {
    spans,
    rows: rows
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.label.localeCompare(b.label))
      .map((r) => ({
        key: r.key,
        label: r.label,
        current: toDollars(r.current),
        prior: toDollars(r.prior),
        change: toDollars(r.change),
        href: ledgerHref([{ by, key: r.key }], spans.current, measure),
      })),
    rest,
    total: { current: toDollars(current), prior: toDollars(prior), change: toDollars(current - prior) },
    priorMonthsMissing: first === null ? 0 : monthsOf(spans.prior).filter((m) => m < first).length,
  };
}

// ---------------------------------------------------------------- build your own

export type ExploreSpanKey = "month" | "lastmonth" | "12m" | "24m" | "ytd" | "lastyear" | "all";
export const EXPLORE_SPAN_KEYS: readonly ExploreSpanKey[] = ["month", "lastmonth", "12m", "24m", "ytd", "lastyear", "all"];

/** A single month named outright, as Overview links one: "2026-09". */
export const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The months a build-your-own question covers; null when there are none to
 * show. Runs of months are COMPLETE months, like every comparison. A single
 * month may be the one being lived in ("this month so far", or its own key),
 * because a breakdown of one month compares it with nothing.
 */
export function exploreSpan(key: string, now: Date, first: string | null): Span | null {
  if (first === null) return null;
  const month = periodKey(now, "MONTH");
  if (key === "month") return { from: month, to: month };
  if (MONTH_KEY.test(key)) return key > month || key < first ? null : { from: key, to: key };
  const last = lastCompleteMonth(now);
  if (last < first) return null;
  const clampFrom = (from: string) => (from < first ? first : from);
  switch (key) {
    case "lastmonth":
      return { from: last, to: last };
    case "12m":
      return { from: clampFrom(addMonths(last, -11)), to: last };
    case "24m":
      return { from: clampFrom(addMonths(last, -23)), to: last };
    case "ytd":
      return { from: clampFrom(`${last.slice(0, 4)}-01`), to: last };
    case "lastyear": {
      const year = Number(last.slice(0, 4)) - (last.endsWith("-12") ? 0 : 1);
      const to = `${year}-12`;
      return to < first ? null : { from: clampFrom(`${year}-01`), to };
    }
    case "all":
      return { from: first, to: last };
    default:
      return null;
  }
}

export interface MonthSeries {
  span: Span;
  months: string[];
  /** One list per measure asked for, a value per month. */
  values: Partial<Record<Measure, number[]>>;
  href: Partial<Record<Measure, string>>;
}

export function monthSeries(
  entries: Entry[],
  measures: Measure[],
  span: Span,
  filter: GroupTarget | null,
): MonthSeries {
  const months = monthsOf(span);
  const values: MonthSeries["values"] = {};
  const href: MonthSeries["href"] = {};
  for (const measure of measures) {
    const totals = byMonth(entries, measure, (e) => matches(e, filter));
    values[measure] = months.map((m) => toDollars(totals.get(m) ?? 0));
    href[measure] = ledgerHref([filter], span, measure);
  }
  return { span, months, values, href };
}

export interface GroupTotal {
  key: string;
  label: string;
  total: number;
  href: string;
}

export interface GroupedSeries {
  span: Span;
  months: string[];
  /** Every group with a nonzero total, largest first, net-refunded groups last. */
  groups: GroupTotal[];
  /** The largest few groups month by month, for the over-time views. */
  lines: { key: string; label: string; byMonth: number[] }[];
  /** Every other group summed per month; null when `lines` holds them all. */
  restByMonth: number[] | null;
  total: number;
  totalByMonth: number[];
}

/** Lines past five read as a tangle; the stacked view folds the rest into one band. */
export const GROUP_LINES = 5;

export function groupedSeries(
  entries: Entry[],
  measure: Measure,
  by: GroupBy,
  span: Span,
  filter: GroupTarget | null,
  accountNames: ReadonlyMap<string, string>,
): GroupedSeries {
  const months = monthsOf(span);
  const index = new Map(months.map((m, i) => [m, i]));
  const groups = new Map<string, { label: string; total: number; byMonth: number[] }>();
  const totalByMonth = new Array<number>(months.length).fill(0);
  for (const e of entries) {
    if (e.measure !== measure || !matches(e, filter)) continue;
    const i = index.get(e.month);
    if (i === undefined) continue;
    const key = groupKey(e, by);
    let g = groups.get(key);
    if (g === undefined) {
      g = { label: groupLabel(e, by, accountNames), total: 0, byMonth: new Array<number>(months.length).fill(0) };
      groups.set(key, g);
    }
    g.total += e.cents;
    g.byMonth[i] += e.cents;
    totalByMonth[i] += e.cents;
  }
  const ranked = [...groups.entries()]
    .filter(([, g]) => g.total !== 0)
    .sort(([, a], [, b]) => b.total - a.total || a.label.localeCompare(b.label));
  const top = ranked.filter(([, g]) => g.total > 0).slice(0, GROUP_LINES);
  const topKeys = new Set(top.map(([key]) => key));
  const others = ranked.filter(([key]) => !topKeys.has(key));
  const restByMonth =
    others.length === 0
      ? null
      : months.map((_, i) => toDollars(others.reduce((s, [, g]) => s + g.byMonth[i], 0)));
  return {
    span,
    months,
    groups: ranked.map(([key, g]) => ({
      key,
      label: g.label,
      total: toDollars(g.total),
      href: ledgerHref([filter, { by, key }], span, measure),
    })),
    lines: top.map(([key, g]) => ({ key, label: g.label, byMonth: g.byMonth.map(toDollars) })),
    restByMonth,
    total: toDollars(totalByMonth.reduce((s, c) => s + c, 0)),
    totalByMonth: totalByMonth.map(toDollars),
  };
}

/** "Oct 2025 to Sep 2026" for a span, re-exported so cards need one import. */
export function spanName(span: Span): string {
  return spanLabel(span.from, span.to);
}
