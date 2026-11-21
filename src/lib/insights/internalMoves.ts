/**
 * Rows that move money between two of the reader's OWN investment accounts
 * whose other side is not on record, so the wording alone would read them as
 * money arriving from outside.
 *
 * The case that made it: a brokerage moved an account's holdings into a new
 * managed account and the feed reported only the arriving side ("TRANSFERRED
 * FROM …"). Once the two accounts are combined into one (sync/combine.ts),
 * that row is money moving inside one pot. Read by its wording it was a
 * deposit the size of the whole account; the value barely changed, so the
 * market was charged the deposit. A row listed here crosses nothing
 * (netWorth.ts crossingAmount), so it is neither a flow nor market movement.
 *
 * A Setting of row ids, written by the combine (never by hand, never by a
 * sync), because it records a decision about a row, not a fact the feed gives.
 */
export const INTERNAL_MOVES_KEY = "netWorth.internalMoves";

export function parseInternalMoves(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set(); // an unreadable list marks nothing: every row is read by its wording, as before
  }
}
