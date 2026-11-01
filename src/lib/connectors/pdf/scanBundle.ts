/**
 * A scan of many statements, regrouped by statement.
 *
 * Paper statements go through a scanner as sheets, in whatever order they
 * were fed, often across several files: one statement's first page can sit
 * in one scan and its continuation in another. Every page of a statement
 * prints the same header (its period, its account, "Page N of M"), so once
 * OCR has given the pages text, the header says which statement each page
 * belongs to, and the printed page number where it goes. A page whose header
 * OCR could not read is an orphan, reported by its place, never guessed.
 */

/** What a page's header says; null where it could not be read. */
export interface PageHeader {
  /** The statement period, as `YYYY-MM-DD_YYYY-MM-DD`. */
  period: string | null;
  /** The account's last four digits. */
  account: string | null;
  pageNo: number | null;
  pageOf: number | null;
}

export interface StatementGroup<T> {
  period: string;
  /** The pages in printed order; those with no readable number last, as given. */
  pages: T[];
  /** The printed page numbers, in that order. */
  printed: (number | null)[];
  /** "of M", when the pages agree on it. */
  expected: number | null;
  /** Every page from 1 to M present, each once. */
  complete: boolean;
}

export function groupStatementPages<T>(pages: { id: T; header: PageHeader }[]): { groups: StatementGroup<T>[]; orphans: T[] } {
  const byPeriod = new Map<string, { id: T; header: PageHeader }[]>();
  const orphans: T[] = [];
  for (const page of pages) {
    if (page.header.period === null) {
      orphans.push(page.id);
      continue;
    }
    byPeriod.set(page.header.period, [...(byPeriod.get(page.header.period) ?? []), page]);
  }
  const groups: StatementGroup<T>[] = [];
  for (const [period, members] of [...byPeriod.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ordered = members
      .map((m, index) => ({ ...m, index }))
      .sort((a, b) => (a.header.pageNo ?? Infinity) - (b.header.pageNo ?? Infinity) || a.index - b.index);
    const printed = ordered.map((m) => m.header.pageNo);
    const ofs = new Set(ordered.map((m) => m.header.pageOf).filter((n): n is number => n !== null));
    const expected = ofs.size === 1 ? [...ofs][0] : null;
    const complete = expected !== null && ordered.length === expected && printed.every((n, k) => n === k + 1);
    groups.push({ period, pages: ordered.map((m) => m.id), printed, expected, complete });
  }
  return { groups, orphans };
}
