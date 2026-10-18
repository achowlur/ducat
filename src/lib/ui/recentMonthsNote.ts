import type { RecentMonths } from "../insights/recentMonths";
import { monthLabel } from "./format";

/**
 * The words for which months a projection averaged (insights/recentMonths.ts),
 * shared by the savings goal, house readiness and the runway so one window
 * reads the same on every screen. Months are named, never counted alone: a
 * reader can check "May and June" against their own records, not "2 months".
 */

/** "April", or "December 2025" when it is not the window's year. */
function nameOf(period: string, year: string): string {
  const label = monthLabel(period);
  return period.startsWith(year) ? label.split(" ")[0] : label;
}

/** A run of consecutive months: "May", "May and June", "April to July". */
function runOf(periods: readonly string[], year: string): string {
  const names = periods.map((p) => nameOf(p, year));
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} to ${names[names.length - 1]}`;
}

const yearOf = (w: RecentMonths) => (w.used[w.used.length - 1] ?? w.dropped[w.dropped.length - 1]?.period ?? "").slice(0, 4);

/** "your last 6 complete months", or "5 of your last 6 complete months" when some were left out. */
export function windowSpan(w: RecentMonths): string {
  const all = w.used.length + w.dropped.length;
  const months = (n: number) => `${n} complete month${n === 1 ? "" : "s"}`;
  return w.dropped.length === 0 ? `your last ${months(all)}` : `${w.used.length} of your last ${months(all)}`;
}

/**
 * The months left out and why: "April left out: it predates 2 of your 4
 * accounts' records." Null when none were. Coverage only grows, so the
 * newest month left out misses the fewest, and the count is "at least" it.
 */
export function droppedNote(w: RecentMonths): string | null {
  if (w.dropped.length === 0) return null;
  const year = yearOf(w);
  const newest = w.dropped[w.dropped.length - 1];
  const one = w.dropped.length === 1;
  return `${runOf(
    w.dropped.map((d) => d.period),
    year,
  )} left out: ${one ? "it predates" : "each predates at least"} ${newest.missing} of your ${newest.total} accounts' records.`;
}

/**
 * The months kept that hold nothing yet from some account, and which way that
 * leans: "May and June predate an account's records, so the pace may run
 * high." Null when every month kept is whole.
 */
export function shortNote(w: RecentMonths, leans: string): string | null {
  if (w.short.length === 0) return null;
  const verb = w.short.length === 1 ? "predates" : "predate";
  return `${runOf(w.short, yearOf(w))} ${verb} an account's records, so ${leans}.`;
}
