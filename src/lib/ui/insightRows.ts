import { granularityOfKey } from "../insights/periods";

/** A stored insight row, narrowed to what every screen actually reads. */
export interface InsightLike {
  type: string;
  period: string;
  payload: unknown;
  dismissed: boolean;
}

export interface MonthlyInsight<T> {
  period: string;
  payload: T;
  dismissed: boolean;
}

/**
 * MONTH-granularity rows only. Insights are generated at four granularities
 * into one table, and every screen shows months — so every screen was
 * repeating this filter, including the try/catch that tolerates a period key
 * the current code no longer recognises.
 */
export function monthlyRows<T extends InsightLike>(rows: T[]): T[] {
  return rows.filter((r) => {
    try {
      return granularityOfKey(r.period) === "MONTH";
    } catch {
      return false;
    }
  });
}

/**
 * One type's rows, OLDEST period first — the order a chart plots in.
 *
 * There were three copies of this and they had diverged: Overview sorted
 * newest-first and carried `dismissed`, Trends sorted oldest-first and
 * dropped it. Callers that want newest first say so (`[...rows].reverse()`),
 * because flipping the shared default silently reverses every Trends chart.
 */
export function ofType<T>(rows: InsightLike[], type: string): MonthlyInsight<T>[] {
  return rows
    .filter((r) => r.type === type)
    .sort((a, b) => (a.period < b.period ? -1 : 1))
    .map((r) => ({ period: r.period, payload: r.payload as T, dismissed: r.dismissed }));
}
