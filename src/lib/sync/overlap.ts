/**
 * Which incoming statement rows the database already holds under ANOTHER
 * source's id.
 *
 * Dedupe is (accountId, externalId), and every source mints its own id: a feed
 * row carries the feed's, a CSV or PDF row a hash of its own text. So the same
 * purchase arriving from a statement and from the feed is two ids, and the key
 * alone would store it twice. The texts disagree too (a card statement lists
 * the transaction date where the feed lists the posting date, and each source
 * truncates a description its own way), so the match is on what both agree
 * on: the account, the signed amount to the cent, and dates within a window.
 *
 * It is a MULTISET match. Two identical coffees on one day are two rows, and
 * only the surplus over what is stored counts as missing. Where a surplus
 * exists and the rows competing for the stored ones are NOT interchangeable
 * (different days), which of them is the missing one cannot be known, so the
 * whole surplus is AMBIGUOUS and none of it is added: a guessed row is worse
 * than a reported one.
 */

export interface IncomingRow {
  /** The caller's correlation key; reported back in the verdicts. */
  key: string;
  date: Date;
  amount: number;
  /**
   * For a row listed by its ORIGINAL date, long before the statement period
   * it appeared in (a card's late-posted refund): the period it posted in.
   * Another source dates it by that posting, so it also matches a stored row
   * of the same amount anywhere in this range.
   */
  postedWithin?: { from: Date; to: Date };
}

export interface StoredRow {
  id: string;
  date: Date;
  amount: number;
}

export type OverlapVerdict =
  /** The database holds this row already; it is not added. */
  | { kind: 'MATCHED'; storedId: string }
  /** Dated before the account's stored history begins: added. */
  | { kind: 'NEW' }
  /** Inside the stored history with nothing to match: a gap, added. */
  | { kind: 'GAP' }
  /** One of several rows competing for fewer stored ones: never added. */
  | { kind: 'AMBIGUOUS'; competing: string[] };

export interface OverlapResult {
  verdicts: Map<string, OverlapVerdict>;
  /** Stored rows some incoming row matched. */
  claimed: Set<string>;
}

const DAY_MS = 86_400_000;

/** Calendar day in UTC; a feed instant and a noon-UTC date compare by day. */
function dayNumber(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * @param historyStart the account's EARLIEST stored transaction, or null when
 *   it has none. Rows before it are NEW rather than GAP: same outcome, but the
 *   report keeps "older history" apart from "holes in what is already here".
 */
export function matchOverlap(
  incoming: IncomingRow[],
  stored: StoredRow[],
  windowDays: number,
  historyStart: Date | null,
): OverlapResult {
  const verdicts = new Map<string, OverlapVerdict>();
  const claimed = new Set<string>();

  const byAmount = new Map<number, { incoming: IncomingRow[]; stored: StoredRow[] }>();
  const group = (amount: number) => {
    const key = cents(amount);
    let g = byAmount.get(key);
    if (g === undefined) {
      g = { incoming: [], stored: [] };
      byAmount.set(key, g);
    }
    return g;
  };
  for (const row of incoming) group(row.amount).incoming.push(row);
  for (const row of stored) group(row.amount).stored.push(row);

  const unmatched = (row: IncomingRow): OverlapVerdict =>
    historyStart !== null && dayNumber(row.date) >= dayNumber(historyStart) ? { kind: 'GAP' } : { kind: 'NEW' };

  for (const g of byAmount.values()) {
    if (g.incoming.length === 0) continue;
    const near = (a: IncomingRow, b: StoredRow) =>
      Math.abs(dayNumber(a.date) - dayNumber(b.date)) <= windowDays ||
      (a.postedWithin !== undefined &&
        dayNumber(b.date) >= dayNumber(a.postedWithin.from) &&
        dayNumber(b.date) <= dayNumber(a.postedWithin.to) + windowDays);

    // Components: incoming rows linked through stored rows they could match.
    const parent = g.incoming.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const s of g.stored) {
      const linked = g.incoming.map((r, i) => (near(r, s) ? i : -1)).filter((i) => i >= 0);
      for (const i of linked.slice(1)) parent[find(i)] = find(linked[0]);
    }
    const components = new Map<number, IncomingRow[]>();
    g.incoming.forEach((r, i) => {
      const root = find(i);
      components.set(root, [...(components.get(root) ?? []), r]);
    });

    for (const rows of components.values()) {
      // Greedy by date gives a MAXIMUM matching here: every window is the same
      // width, so taking rows in date order and giving each the earliest
      // stored row it can reach never strands a later one.
      const ordered = [...rows].sort((a, b) => a.date.getTime() - b.date.getTime());
      const free = g.stored
        .filter((s) => !claimed.has(s.id) && ordered.some((r) => near(r, s)))
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      const left: IncomingRow[] = [];
      for (const row of ordered) {
        const pick = free.find((s) => !claimed.has(s.id) && near(row, s));
        if (pick === undefined) {
          left.push(row);
        } else {
          claimed.add(pick.id);
          verdicts.set(row.key, { kind: 'MATCHED', storedId: pick.id });
        }
      }
      if (left.length === 0) continue;

      const contested = rows.length > left.length;
      const interchangeable = new Set(rows.map((r) => dayNumber(r.date))).size === 1;
      for (const row of left) {
        verdicts.set(
          row.key,
          contested && !interchangeable
            ? { kind: 'AMBIGUOUS', competing: ordered.map((r) => r.key) }
            : unmatched(row),
        );
      }
    }
  }
  return { verdicts, claimed };
}
