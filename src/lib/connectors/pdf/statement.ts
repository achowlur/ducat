import type { AccountType } from '../../../types/contracts';
import type { TextCell, TextLine } from './lines';

/**
 * One statement as a layout parser reads it, in the app's sign convention
 * (src/types/contracts.ts): amounts positive IN and negative OUT, balances
 * negative on a CREDIT account. Every layout converts its own printing into
 * this, so nothing downstream knows which bank a statement came from.
 */
export interface StatementRow {
  /** The date the statement lists the row under, at noon UTC. */
  date: Date;
  description: string;
  amount: number;
  /**
   * Set only on a late-posted row (see settleLatePostings): the merchant's own
   * date, while `date` has moved to the opening day of the statement the row
   * appeared on.
   */
  transactionDate?: Date;
}

/**
 * A total the statement prints that its rows must add up to: a section
 * subtotal, or the summary's deposits or withdrawals.
 */
export interface StatementCheck {
  label: string;
  printedCents: number;
  /** Which rows the printed total covers. */
  rows: (row: StatementRow) => boolean;
  /**
   * Compare with sign. A subtotal is printed as a magnitude, so by default
   * only magnitudes are compared; a running balance (the change since the
   * opening balance) has a sign that matters.
   */
  signed?: boolean;
}

export interface ParsedStatement {
  layout: string;
  institution: string;
  accountType: AccountType;
  /** The last four digits the statement prints for the account. */
  accountLast4: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: number;
  closingBalance: number;
  /**
   * A change in value the statement prints and no row explains: an investment
   * account's market movement. The balance check then reads opening + rows +
   * this = closing. Absent on a bank or card statement, where every change is
   * a row.
   */
  marketChange?: number;
  rows: StatementRow[];
  checks: StatementCheck[];
}

export interface StatementLayout {
  id: string;
  /** Recognises the layout from what the first page says, never from a date. */
  detect(lines: TextLine[]): boolean;
  /**
   * One statement per account the file covers: a bank or card statement is
   * one, a brokerage report can hold several. Throws, naming what it could
   * not read, rather than return a guess.
   */
  parse(lines: TextLine[]): ParsedStatement[];
}

/** Money as integer cents, so a sum of hundreds of rows cannot drift. */
export function cents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * "$1,234.56", "+$1,234.56", "-$1,234.56", "$-1,234.56", "1,234.56-",
 * "(1,234.56)", "1,234.56 CR", ".99" → signed dollars as printed (credit
 * markers negative). Null for anything else.
 */
export function parseMoney(raw: string): number | null {
  // A typeset statement may print its minus as U+2212 or a dash.
  let text = raw.trim().replace(/\s+/g, '').replace(/[−‒–—]/g, '-');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/CR$/i.test(text)) {
    negative = !negative;
    text = text.slice(0, -2);
  }
  // The dollar sign sits on either side of a leading sign: "-$5.00", "$-5.00".
  text = text.replace(/^\$/, '');
  if (text.startsWith('+')) {
    text = text.slice(1);
  } else if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.endsWith('-')) {
    negative = !negative;
    text = text.slice(0, -1);
  }
  text = text.replace(/^\$/, '');
  if (/^\.\d{2}$/.test(text)) text = `0${text}`;
  if (!/^\d{1,3}(,\d{3})*\.\d{2}$|^\d+\.\d{2}$/.test(text)) return null;
  const value = Number(text.replace(/,/g, ''));
  return negative ? -value : value;
}

/**
 * A description long enough to reach the amount column runs into the amount,
 * and the two read as one cell ("EXAMPLE STORE 0000 SPRINGFIELD IL 12.34").
 * When a line's last cell ENDS at the amount column but is not money itself,
 * a trailing money token is split back off it. Anything else is left alone.
 */
export function splitTrailingAmount(cells: TextCell[], columnXEnd: number, slack: number): TextCell[] {
  const last = cells[cells.length - 1];
  if (last === undefined || Math.abs(last.xEnd - columnXEnd) > slack || parseMoney(last.text) !== null) return cells;
  const m = /^(.*\S)\s+(\S+)$/.exec(last.text);
  if (m === null || parseMoney(m[2]) === null) return cells;
  return [...cells.slice(0, -1), { x: last.x, xEnd: last.xEnd, text: m[1] }, { x: last.xEnd, xEnd: last.xEnd, text: m[2] }];
}

/** A calendar date at noon UTC, the convention every importer stores. */
export function noonUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 12));
}

/** "MM/DD/YY" or "MM/DD/YYYY" → noon UTC; null when it is not a real date. */
export function parseFullDate(raw: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw.trim());
  if (m === null) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return validDate(year, Number(m[1]), Number(m[2]));
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** "December 8, 2018" (or "Dec 8, 2018") → noon UTC; null when it is not a real date. */
export function parseLongDate(raw: string): Date | null {
  const m = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/.exec(raw.trim());
  if (m === null) return null;
  const name = m[1].toLowerCase();
  const month = MONTHS.findIndex((full) => full === name || full.slice(0, 3) === name) + 1;
  return month === 0 ? null : validDate(Number(m[3]), month, Number(m[2]));
}

function validDate(year: number, month: number, day: number): Date | null {
  const date = noonUtc(year, month, day);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

/**
 * A row printed as "MM/DD" with no year.
 *
 * A statement never lists a row from after it closed, so the year is the
 * LATEST one that does not put the date past the closing date (plus a week,
 * for a row dated the evening it closed). One rule covers a December-to-
 * January statement and a card's late-posted row, which keeps its original
 * transaction date: a refund can be listed months before the period it
 * appears in. An impossible date (02/30) is an error, never a guess.
 */
export function rowDate(raw: string, periodEnd: Date): Date {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(raw.trim());
  if (m === null) throw new Error(`"${raw}" is not a MM/DD date`);
  const month = Number(m[1]);
  const day = Number(m[2]);
  const latest = periodEnd.getTime() + 7 * 86_400_000;
  const endYear = periodEnd.getUTCFullYear();
  const year = Date.UTC(endYear, month - 1, day, 12) <= latest ? endYear : endYear - 1;
  const date = validDate(year, month, day);
  if (date === null) throw new Error(`${raw} is not a real date`);
  return date;
}

/** A row dated more than this many days before its statement opens was posted late. */
export const LATE_POSTING_DAYS = 7;

/**
 * A card can list a late-posted charge under the date the merchant gave it,
 * months before the statement it appears on. The money moved during THIS
 * statement's period, and a month already closed should not reopen for it,
 * so such a row is dated on the statement's opening day and carries the
 * merchant's date in `transactionDate`. A posting lag of a few days is
 * ordinary and keeps the row's own date, as a CSV export would.
 *
 * Runs after reconcile, which checks rows by identity; dates play no part in
 * a statement adding up.
 */
export function settleLatePostings(statement: ParsedStatement): ParsedStatement {
  const cutoff = statement.periodStart.getTime() - LATE_POSTING_DAYS * 86_400_000;
  if (!statement.rows.some((r) => r.date.getTime() < cutoff)) return statement;
  return {
    ...statement,
    rows: statement.rows.map((r) =>
      r.date.getTime() < cutoff ? { ...r, date: statement.periodStart, transactionDate: r.date } : r,
    ),
  };
}

/** "(transaction date 03/11/2026)": what a late-posted row's description carries. */
export function transactionDateNote(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `(transaction date ${mm}/${dd}/${date.getUTCFullYear()})`;
}

/**
 * Whether a parsed statement adds up: the opening balance plus every row is
 * the closing balance, to the cent, and every printed total matches the rows
 * it covers. A statement that fails is refused WHOLE, which is what catches a
 * dropped row, a missed continuation page or a flipped sign without anyone
 * reading the statement.
 */
export function reconcile(statement: ParsedStatement): string[] {
  const problems: string[] = [];
  const sum = statement.rows.reduce((total, r) => total + cents(r.amount), 0);
  const expected =
    cents(statement.closingBalance) - cents(statement.openingBalance) - cents(statement.marketChange ?? 0);
  if (sum !== expected) {
    problems.push(
      statement.marketChange === undefined
        ? `rows add up to ${(sum / 100).toFixed(2)} but the balance moved ${(expected / 100).toFixed(2)}`
        : `rows add up to ${(sum / 100).toFixed(2)} but the value moved ${(expected / 100).toFixed(2)} beyond the printed market change`,
    );
  }
  for (const check of statement.checks) {
    const covered = statement.rows.filter(check.rows).reduce((total, r) => total + cents(r.amount), 0);
    const [got, printed] = check.signed === true ? [covered, check.printedCents] : [Math.abs(covered), Math.abs(check.printedCents)];
    if (got !== printed) {
      problems.push(
        `${check.label}: rows add up to ${(got / 100).toFixed(2)}, the statement prints ${(printed / 100).toFixed(2)}`,
      );
    }
  }
  return problems;
}
