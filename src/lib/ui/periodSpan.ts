import { periodEndExclusive, periodStart } from "../insights/periods";
import { monthLabel, shortMonthLabel } from "./format";

/**
 * The ledger's `?period=`, owned here: one period key ("2026-07", "2026-Q3",
 * "2026"), or a SPAN of whole months written "2025-10..2026-09", inclusive at
 * both ends.
 *
 * The span exists so a /trends figure can open the rows behind it. Its
 * comparisons run over twelve months, and a link that could only name ONE
 * month showed a twelfth of the total it was tapped from. It rides the
 * existing parameter rather than a from/to pair so the ledger's period select
 * can carry it as one synthetic option, the way the category select carries a
 * set: two parameters with no visible control would be dropped by the filter
 * form's next submit.
 */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface PeriodFilter {
  start: Date;
  /** Exclusive: the instant the next period starts. */
  end: Date;
  /** The months of a span; null for a single period key. */
  span: { from: string; to: string } | null;
}

/** Null for absent or unparseable input, which the ledger ignores rather than crash. */
export function parsePeriodParam(raw: string | undefined): PeriodFilter | null {
  if (raw === undefined || raw === "") return null;
  const parts = raw.split("..");
  if (parts.length === 2) {
    const [from, to] = parts;
    if (!MONTH.test(from) || !MONTH.test(to) || from > to) return null;
    return { start: periodStart(from), end: periodEndExclusive(to), span: { from, to } };
  }
  try {
    return { start: periodStart(raw), end: periodEndExclusive(raw), span: null };
  } catch {
    return null;
  }
}

/** The parameter for a run of months; one month is just its key. */
export function spanParam(from: string, to: string): string {
  return from === to ? from : `${from}..${to}`;
}

/** "Oct 2025 to Sep 2026"; one month reads as its full name. */
export function spanLabel(from: string, to: string): string {
  return from === to ? monthLabel(from) : `${shortMonthLabel(from)} to ${shortMonthLabel(to)}`;
}
