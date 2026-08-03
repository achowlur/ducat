import { periodKey } from "../insights/periods";

/**
 * Which months /insights can land on, and where the arrows lead.
 *
 * The list is derived from stored insight rows, and analyzers emit only ACTIVE
 * periods — so on the 1st of a month, before anything has synced, the month
 * being lived in has no rows and used to be unreachable: every request clamped
 * back to the prior month, and the three forward-looking panels (pace,
 * commitments, goals) were hidden on exactly the day they are most useful.
 * "Due in the next 30 days" peaks in value on day 1, and none of those panels
 * needs a row FROM the month itself — commitments read detected/registered
 * subscriptions, goals read balances plus PRIOR months' cash flow.
 *
 * So the CURRENT CALENDAR MONTH is admitted even with no rows, and ONLY that:
 * any other rowless month still clamps to the default.
 *
 * The DEFAULT is the lived-in month too (reversed 2026-08-02). When the
 * admission shipped, the current-month view held one quiet line, so the page
 * kept opening on the latest month WITH rows and the empty month was a step
 * through `›`. Goals, readiness and the commitments/pace panels have since
 * made the current month the page's richest view — and every one of them is
 * gated to exactly that month, so defaulting to the latest month with rows
 * hid the page's best content every month-start, on the days it answers the
 * most. Prior months stay one `‹` away.
 *
 * "Current month" comes from `periodKey`, i.e. UTC accessors, like every
 * period bound in the app — a local-time month here could disagree with the
 * engine's month boundary by a day.
 */
export interface PeriodSelection {
  period: string;
  prevPeriod: string | null;
  nextPeriod: string | null;
  /**
   * The period that was ASKED for and refused, when one was. The clamp itself
   * is correct and stays; what was wrong is that it happened in silence — the
   * URL kept saying `?period=2026-08` while the page rendered July and nothing
   * acknowledged the substitution, which is the same hazard Overview already
   * works around by refusing to link a period /trends has no row for ("a link
   * that lands somewhere it did not name is worse than no link"). Null when
   * the request was honoured, absent, or empty.
   */
  clampedFrom: string | null;
}

/**
 * @param withRows Periods of the stored MONTH-granularity insight rows, in any
 *   order, duplicates fine — pass `rows.map((r) => r.period)`.
 * @returns Null when no month has rows at all: a first-run database gets the
 *   "no insights yet" page, not an empty month admitted by the boundary rule.
 */
export function selectPeriod(
  withRows: readonly string[],
  requested: string | undefined,
  now: Date,
): PeriodSelection | null {
  const available = [...new Set(withRows)].sort();
  if (available.length === 0) return null;

  const current = periodKey(now, "MONTH");
  const reachable = available.includes(current) ? available : [...available, current].sort();

  // `current` is always in `reachable` by construction, so the default — and
  // any request for a month that is not reachable — lands on the lived-in month.
  const asked = requested === undefined || requested === "" ? null : requested;
  const honoured = asked !== null && reachable.includes(asked);
  const period = honoured ? asked : current;
  const idx = reachable.indexOf(period);

  return {
    period,
    prevPeriod: idx > 0 ? reachable[idx - 1] : null,
    nextPeriod: idx < reachable.length - 1 ? reachable[idx + 1] : null,
    clampedFrom: asked !== null && !honoured ? asked : null,
  };
}
