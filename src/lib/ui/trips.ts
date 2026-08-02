import { periodEndExclusive, periodStart } from "../insights/periods";
import { groupHref } from "./groupFilter";

/**
 * The /insights TRIPS rows: every group with activity in the viewed period,
 * each carrying its this-period portion, its running all-time net, its span,
 * and the link back to the group-filtered ledger.
 *
 * FACTS, not analytics. Every figure is the plain signed sum of the tagged
 * rows exactly as the group's ledger view lists them — transfers included,
 * because the ledger view includes them and a total that disagrees with the
 * view it links to is the two-totals bug. That is also why the section owes no
 * chip: nothing here is projected or assumed, it is arithmetic over rows the
 * reader can click through to.
 *
 * A period with no tagged activity contributes nothing; no tagged rows at all
 * means an empty array and the section is ABSENT (opt-in content, like goals —
 * an empty "Trips" heading would imply the engine went looking).
 */

export interface TaggedRow {
  groupLabel: string;
  date: Date;
  amount: number;
  flow: string;
}

export interface TripRow {
  label: string;
  href: string;
  /** Signed net of the group's rows inside the viewed period. */
  periodNet: number;
  periodRowCount: number;
  /** Signed net of every row the group holds, all time. */
  runningNet: number;
  rowCount: number;
  firstDate: Date;
  lastDate: Date;
  /** TRANSFER rows carried in the sums, so the wording can say so. */
  transferCount: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function tripsForPeriod(rows: readonly TaggedRow[], period: string): TripRow[] {
  if (rows.length === 0) return [];
  let start: Date;
  let end: Date;
  try {
    start = periodStart(period);
    end = periodEndExclusive(period);
  } catch {
    return []; // unparseable key — nothing sane to bound the portion with
  }

  const byLabel = new Map<string, TaggedRow[]>();
  for (const row of rows) {
    const list = byLabel.get(row.groupLabel) ?? [];
    list.push(row);
    byLabel.set(row.groupLabel, list);
  }

  const trips: TripRow[] = [];
  for (const [label, list] of byLabel) {
    const inPeriod = list.filter((r) => r.date >= start && r.date < end);
    if (inPeriod.length === 0) continue; // no activity this period — not shown
    const dates = list.map((r) => r.date.getTime());
    trips.push({
      label,
      href: groupHref(label),
      periodNet: round2(inPeriod.reduce((sum, r) => sum + r.amount, 0)),
      periodRowCount: inPeriod.length,
      runningNet: round2(list.reduce((sum, r) => sum + r.amount, 0)),
      rowCount: list.length,
      firstDate: new Date(Math.min(...dates)),
      lastDate: new Date(Math.max(...dates)),
      transferCount: list.filter((r) => r.flow === "TRANSFER").length,
    });
  }
  return trips.sort((a, b) => a.label.localeCompare(b.label));
}
