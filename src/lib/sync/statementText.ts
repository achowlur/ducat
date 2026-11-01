import type { StatementRow } from '../connectors/pdf/statement';

/**
 * Refilling the text of rows a statement import stored EMPTY.
 *
 * An OCR'd statement can lose a row's description on the way in (the text
 * drifted off its row and the layout of the day did not rejoin it) while the
 * row's date and amount, which the balance check guards, came through. The
 * row is right and nameless. Re-reading the same file with a layout that
 * keeps the text gives every row again; this pairs the nameless stored rows
 * with the rows read now, by date and amount, within the one import batch
 * the file made, so nothing outside that file is touched.
 *
 * Pairing is a MULTISET: two stored rows of one amount on one day take two
 * read rows of that amount and day. Where the read rows for a date and amount
 * do not all say the same thing and there are fewer nameless rows than read
 * rows, which text belongs to which row cannot be told, and those rows are
 * left as they are, counted.
 */
export interface NamelessRow {
  id: string;
  /** The stored date, noon UTC. */
  date: Date;
  amount: number;
}

export interface TextFill {
  id: string;
  description: string;
  /** The text the merchant is read from, when the layout gives one apart from the description. */
  merchantText?: string;
}

export interface TextPlan {
  fills: TextFill[];
  /** Stored nameless rows no read row matches, or that several different texts could name. */
  unmatched: NamelessRow[];
}

const key = (date: Date, amount: number) => `${date.toISOString().slice(0, 10)}|${Math.round(amount * 100)}`;

export function planTextFill(nameless: NamelessRow[], read: StatementRow[]): TextPlan {
  const pool = new Map<string, StatementRow[]>();
  for (const r of read) {
    if (r.description.trim() === '') continue;
    const k = key(r.date, r.amount);
    pool.set(k, [...(pool.get(k) ?? []), r]);
  }
  const fills: TextFill[] = [];
  const unmatched: NamelessRow[] = [];
  const byKey = new Map<string, NamelessRow[]>();
  for (const n of nameless) {
    const k = key(n.date, n.amount);
    byKey.set(k, [...(byKey.get(k) ?? []), n]);
  }
  for (const [k, rows] of byKey) {
    const candidates = pool.get(k) ?? [];
    const texts = new Set(candidates.map((c) => `${c.description}|${c.payee ?? ''}`));
    // Every candidate says the same, or there is one candidate per row: the
    // pairing is determined. Otherwise which text is whose cannot be told.
    const decided = candidates.length >= rows.length && (texts.size === 1 || candidates.length === rows.length);
    if (!decided) {
      unmatched.push(...rows);
      continue;
    }
    rows.forEach((row, i) => {
      const c = candidates[i];
      fills.push({ id: row.id, description: c.description, ...(c.payee === undefined ? {} : { merchantText: c.payee }) });
    });
  }
  return { fills, unmatched };
}
