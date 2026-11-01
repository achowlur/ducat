import type { TextCell, TextLine } from '../lines';
import type { PageHeader } from '../scanBundle';
import {
  cents,
  parseFullDate,
  parseMoney,
  rowDate,
  splitTrailingAmount,
  type StatementCheck,
  type StatementLayout,
  type StatementRow,
} from '../statement';

/**
 * Wells Fargo credit card statements.
 *
 * Every page prints the account's last four digits, the statement period and
 * "Page N of M" (the wording changed in 2024: see PERIOD and ACCOUNT). Page
 * one's account summary lists the previous balance, payments, other credits,
 * cash advances, purchases, fees, interest and the new balance. The
 * transactions table (Card Ending in, Trans Date, Post Date, Reference
 * Number, Description, Credits, Charges; older statements print one date)
 * runs under section headings, each closed by a "TOTAL ... FOR THIS PERIOD"
 * line, and a number means what its COLUMN says: a credit under Credits, a
 * charge under Charges, no sign printed. A row is dated by its post date. An
 * interest charge is a row with no date at all, dated on the closing day.
 *
 * The statements this was written for were scans, mailed on paper and OCR'd
 * (docs/pdf-import.md). OCR gives each block of a page a baseline of its
 * own, so the amount column can sit a few points, even a whole row, off the
 * rows beside it: the amounts are read as a column of their own and matched
 * to a section's rows by ORDER when the counts agree, by nearness otherwise.
 * Two dates can read as one cell, and a digit as the letter shaped like it;
 * inside a cell that can hold only a date or an amount those look-alikes are
 * read as digits. Nothing else is guessed: a row whose post date is
 * unreadable, falls outside the period or has no amount refuses the
 * statement, and the balance and section totals still have to add up to the
 * cent. A date misread as ANOTHER valid date inside the period is the one
 * error no check here can see.
 */

const ROW_DATE = /^\d{1,2}\/\d{1,2}$/;
/** "Statement Period 03/03/2025 to 04/02/2025"; newer statements say "Statement Billing Period". */
const PERIOD = /Statement (?:Billing )?Period\s+(\S+)\s+to\s+(\S+)/i;
/** "Account ending in 1234"; newer statements say "Account Number Ending in 1234". */
const ACCOUNT = /(?:Account ending in|Ending in)\s+(\S{4})\b/i;
/** "Page 2 of 3". */
const PAGE_MARK = /\bPage\s+(\S{1,2})\s+of\s+(\S{1,2})\b/i;
/** How far an amount's right edge may sit from its column header's, OCR jitter included. */
const COLUMN_SLACK = 14;
/** A line this close to another is read with it: a figure's baseline off its label's. */
const NEAR_LINE = 6;
/** The Credits column's right edge sits this far right of where "Reference Number" starts, on every statement seen. */
const CREDITS_AFTER_REFERENCE = 287;
/** The Charges column's right edge sits this far right of the Credits column's. */
const CHARGES_AFTER_CREDITS = 44;
/** An amount this close to a row is that row's, when order cannot decide; rows sit about 7 points apart. */
const AMOUNT_NEAR = 4;
/**
 * Where a page's table ends: the foot of page one carries a notice, a
 * "Continued" mark and the payment coupon, whose figures sit under the
 * Charges column and are no rows.
 */
const PAGE_FOOT = /IMPORTANT INFORMATION ABOUT YOUR ACCOUNT|^Continued\b|^Account Number$/i;
/** A row posted on the day before the period opened is listed on this statement: the cut falls inside that day. */
const POSTED_BEFORE_OPENING_DAYS = 1;
/** A row dated by its trans date (its post date unreadable) can precede the period by the posting lag. */
const TRANS_BEFORE_OPENING_DAYS = 7;
/** The first token after the dates is the reference number: this long, no spaces. */
const REFERENCE = /^[A-Z0-9]{10,}$/i;
const NOISE_TOKEN = /^[_=~.,:;'"|-]+$/;
const CARD_DIGITS = /^\d{4}$/;

type Section = 'payments' | 'otherCredits' | 'cashAdvances' | 'purchases' | 'fees' | 'interest';

const SECTIONS: { key: Section; heading: RegExp; total: RegExp; summary: RegExp; name: string }[] = [
  { key: 'payments', heading: /^Payments$/i, total: /^TOTAL PAYMENTS FOR THIS PERIOD/i, summary: /^[^A-Za-z]*Payments$/, name: 'payments' },
  { key: 'otherCredits', heading: /^Other Credits$/i, total: /^TOTAL OTHER CREDITS FOR THIS PERIOD/i, summary: /^[^A-Za-z]*Other Credits$/, name: 'other credits' },
  { key: 'cashAdvances', heading: /^Cash Advances$/i, total: /^TOTAL CASH ADVANCES FOR THIS PERIOD/i, summary: /^[^A-Za-z]*Cash Advances$/, name: 'cash advances' },
  { key: 'purchases', heading: /^Purchases, Balance Transfers/i, total: /^TOTAL PURCHASES, BALANCE TRANSFERS/i, summary: /^[^A-Za-z]*Purchases, Balance Transfers/, name: 'purchases, balance transfers and other charges' },
  { key: 'fees', heading: /^Fees Charged$/i, total: /^TOTAL FEES CHARGED FOR THIS PERIOD/i, summary: /^[^A-Za-z]*Fees Charged$/, name: 'fees charged' },
  { key: 'interest', heading: /^Interest Charged$/i, total: /^TOTAL INTEREST CHARGED FOR THIS PERIOD/i, summary: /^[^A-Za-z]*Interest Charged$/, name: 'interest charged' },
];

/** Sections whose rows carry no date: the charge is listed by name alone. */
const UNDATED_SECTIONS: Section[] = ['fees', 'interest'];

/** Letters OCR reads for digits, inside text that can only be digits. */
function lookalikesToDigits(text: string): string {
  return text
    .replace(/[OoQ]/g, '0')
    .replace(/[lI|!]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/B/g, '8')
    .replace(/[Zz]/g, '2');
}

/** Scan noise around a date or amount: underscores, stray punctuation. */
function trimNoise(text: string): string {
  return text.replace(/^[^$(+\-0-9A-Za-z]+/, '').replace(/[^0-9A-Za-z)]+$/, '');
}

/** "MM/DD" as printed, or null; look-alike letters read as digits. */
function asRowDate(text: string): string | null {
  const cleaned = lookalikesToDigits(text.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, ''));
  return ROW_DATE.test(cleaned) ? cleaned : null;
}

/**
 * Signed dollars as printed, or null. Every amount on the statement carries
 * cents, so OCR's two ways of losing the point are read back: a comma, colon
 * or semicolon two digits from the end is the point ("12,34"), and a bare run
 * of digits has it before its last two ("1234" is 12.34; "5,000", a credit
 * limit, stays no amount).
 */
function asMoney(text: string): number | null {
  const cleaned = trimNoise(text);
  const direct = parseMoney(cleaned) ?? parseMoney(lookalikesToDigits(cleaned));
  if (direct !== null) return direct;
  const digits = lookalikesToDigits(cleaned);
  const pointed = /^\$?\d{3,}$/.test(digits)
    ? `${digits.slice(0, -2)}.${digits.slice(-2)}`
    : /^[^.]*[,:;]\d{2}$/.test(digits)
      ? `${digits.slice(0, -3)}.${digits.slice(-2)}`
      : null;
  return pointed === null ? null : parseMoney(pointed);
}

/** Positions and a SHAPE only (letters as X, digits as #): where it sat, never what it said. */
function shape(text: string): string {
  return text.replace(/[A-Z]/g, 'X').replace(/[a-z]/g, 'x').replace(/\d/g, '#');
}

function tryRowDate(text: string, periodEnd: Date): Date | null {
  try {
    return rowDate(text, periodEnd);
  } catch {
    return null;
  }
}

function cellMatching(line: TextLine, pattern: RegExp): TextCell | undefined {
  return line.cells.find((c) => pattern.test(c.text));
}

/** The first money among cells, in order; null when none. */
function firstMoney(cells: TextCell[]): number | null {
  for (const cell of cells) {
    const value = asMoney(cell.text);
    if (value !== null) return value;
  }
  return null;
}

/**
 * The amount printed after a labelled cell: on its own line, or, when OCR
 * gave the summary's figures a baseline of their own, the first money right
 * of the label on the nearest line within NEAR_LINE. The first label that
 * has one wins; null when none does.
 */
function summaryValue(lines: TextLine[], label: RegExp): number | null {
  for (const [index, line] of lines.entries()) {
    const cell = cellMatching(line, label);
    if (cell === undefined) continue;
    const value = valueBeside(lines, index, cell);
    if (value !== null) return value;
  }
  return null;
}

/** The amount after a label cell on its line, or on the nearest line within NEAR_LINE, right of the label. */
function valueBeside(lines: TextLine[], index: number, cell: TextCell): number | null {
  const line = lines[index];
  const own = firstMoney(line.cells.slice(line.cells.indexOf(cell) + 1));
  if (own !== null) return own;
  const near = [index - 1, index + 1, index - 2, index + 2]
    .map((i) => lines[i])
    .filter((l) => l !== undefined && l.page === line.page && Math.abs(l.y - line.y) <= NEAR_LINE)
    .sort((a, b) => Math.abs(a.y - line.y) - Math.abs(b.y - line.y));
  for (const l of near) {
    const value = firstMoney(l.cells.filter((c) => c.x >= cell.xEnd - 2));
    if (value !== null) return value;
  }
  return null;
}

/**
 * The previous balance when OCR spoiled its label beyond recognition: the
 * account summary is a column of labels at one left edge, "= New Balance"
 * last, and the previous balance is its FIRST line. So: the first line above
 * "= New Balance" on its page, at the same left edge, that carries an amount
 * (on it, or on a near line to the right of the label).
 */
function previousBalanceByPlace(lines: TextLine[]): number | null {
  const index = lines.findIndex((l) => l.cells.length > 0 && /^[^A-Za-z]*New Balance$/i.test(l.cells[0].text));
  if (index < 0) return null;
  const anchor = lines[index];
  const edge = anchor.cells[0].x;
  for (let i = 0; i < index; i++) {
    const line = lines[i];
    if (line.page !== anchor.page || line.y <= anchor.y || line.y - anchor.y > SUMMARY_HEIGHT) continue;
    const first = line.cells[0];
    if (first === undefined || Math.abs(first.x - edge) > 8 || /^[^A-Za-z]*[A-Za-z]+ Summary/i.test(first.text)) continue;
    const value = valueBeside(lines, i, first);
    if (value !== null) return value;
  }
  return null;
}

/** The account summary's height: the previous balance sits within this of "= New Balance". */
const SUMMARY_HEIGHT = 90;

/**
 * The card's name, printed across the top of every page ("Wells Fargo
 * Example Rewards® Card"), read from the summary page: the cells left of the
 * page's right-hand block on the first line that ends in CARD and the lines
 * within NEAR_LINE of it (OCR splits the name over two baselines), joined in
 * reading order and cut at CARD. Letters only, upper case; null when no such
 * line reads.
 */
function cardNameOf(pageLines: TextLine[]): string | null {
  const index = pageLines.findIndex((l) => l.cells.some((c) => c.x < CARD_NAME_MAX_X && /\bCARD\b/i.test(c.text)));
  if (index < 0) return null;
  const anchor = pageLines[index];
  const cells = pageLines
    .filter((l) => Math.abs(l.y - anchor.y) <= NEAR_LINE)
    .flatMap((l) => l.cells.filter((c) => c.x < CARD_NAME_MAX_X))
    .sort((a, b) => a.x - b.x);
  const text = cells.map((c) => c.text).join(' ');
  const cut = /^(.*?\bCARD)\b/i.exec(text);
  if (cut === null) return null;
  const words = cut[1].toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  return words.length === 0 ? null : words.join(' ');
}

/** The card's name sits left of this; the right-hand block of the page top holds the page's own marks. */
const CARD_NAME_MAX_X = 465;

/** The value most pages agree on; OCR can spoil one page's header. */
function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

interface Columns {
  /** Where the Reference Number column starts: a row's dates sit left of it. */
  reference: number;
  credits: number;
  charges: number;
}

/**
 * The table header of a page: the line holding the Credits label, with the
 * Charges and Reference Number labels on it or on a line within NEAR_LINE
 * (OCR can set parts of the header a few points apart). Returns the columns
 * and the index of the last line the header occupies.
 */
function tableHeader(pageLines: TextLine[]): { columns: Columns; end: number } | null {
  // A label can carry scan noise after it ("Charges|"), hence no end anchor.
  const label = (l: TextLine, pattern: RegExp) => cellMatching(l, pattern);
  for (const [index, line] of pageLines.entries()) {
    const reference = label(line, /^Reference\b/i);
    if (reference === undefined) continue;
    const near = [index, index - 1, index + 1, index - 2, index + 2]
      .map((i) => pageLines[i])
      .filter((l) => l !== undefined && Math.abs(l.y - line.y) <= NEAR_LINE);
    const creditsLine = near.find((l) => label(l, /^Credits\b/i) !== undefined);
    const chargesLine = near.find((l) => label(l, /^Charges\b/i) !== undefined);
    // OCR can lose a label; the columns then sit where the header's layout
    // puts them, measured from Reference Number (CREDITS_AFTER_REFERENCE)
    // and from Credits (CHARGES_AFTER_CREDITS). A wrong guess reads no
    // amount at all, which the balance check refuses.
    const credits = creditsLine === undefined ? reference.x + CREDITS_AFTER_REFERENCE : (label(creditsLine, /^Credits\b/i) as TextCell).xEnd;
    const charges = chargesLine === undefined ? credits + CHARGES_AFTER_CREDITS : (label(chargesLine, /^Charges\b/i) as TextCell).xEnd;
    const used = [line, creditsLine, chargesLine].filter((l): l is TextLine => l !== undefined);
    return { columns: { reference: reference.x, credits, charges }, end: Math.max(...used.map((l) => pageLines.indexOf(l))) };
  }
  return null;
}

/** An amount read under one of the two columns, signed by which: a credit returns money, a charge takes it. */
interface Amount {
  y: number;
  amount: number;
}

/**
 * A line's cells with every amount under a column lifted out, signed; a
 * description that ran into its amount is split first. The text cells are
 * what is left, in order.
 */
function liftAmounts(line: TextLine, columns: Columns): { text: TextCell[]; amounts: Amount[] } {
  let cells = line.cells;
  for (const column of ['credits', 'charges'] as const) cells = splitTrailingAmount(cells, columns[column], COLUMN_SLACK);
  const text: TextCell[] = [];
  const amounts: Amount[] = [];
  for (const cell of cells) {
    const column = (['credits', 'charges'] as const).find((c) => Math.abs(cell.xEnd - columns[c]) <= COLUMN_SLACK);
    const value = column === undefined ? null : asMoney(cell.text);
    if (column === undefined || value === null) text.push(cell);
    else amounts.push({ y: line.y, amount: column === 'credits' ? value : -value });
  }
  return { text, amounts };
}

/**
 * A post date OCR got ONE digit of wrong: left unreadable ("0?/14"), or read
 * as another digit so that the result is no date at all ("14/30", "10/80")
 * or one outside the statement ("05/15" on a March statement). It is read
 * when exactly one digit, changed, makes a real date inside the window;
 * null otherwise. A date already inside the window is returned as it is.
 * The window is the statement's own period, so this reads post dates only.
 */
function resolvePostDate(text: string, periodEnd: Date, earliest: number): string | null {
  const cleaned = lookalikesToDigits(text.replace(/^[^0-9A-Za-z]+|[^0-9A-Za-z]+$/g, '')).replace(/[^0-9/]/g, '?');
  if (!/^[0-9?]{1,2}\/[0-9?]{1,2}$/.test(cleaned)) return null;
  const inside = (candidate: string): boolean => {
    const date = tryRowDate(candidate, periodEnd);
    return date !== null && date.getTime() >= earliest && date <= periodEnd;
  };
  const unknown = (cleaned.match(/\?/g) ?? []).length;
  if (unknown > 1) return null;
  if (unknown === 0 && inside(cleaned)) return cleaned;
  const positions = unknown === 1 ? [cleaned.indexOf('?')] : [...cleaned].map((c, i) => (c === '/' ? -1 : i)).filter((i) => i >= 0);
  const found = new Set<string>();
  for (const p of positions) {
    for (let d = 0; d <= 9; d++) {
      const candidate = `${cleaned.slice(0, p)}${d}${cleaned.slice(p + 1)}`;
      if (candidate !== cleaned && inside(candidate)) found.add(candidate);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/** What rowDates needs to read a post date with one digit missing. */
interface DateWindow {
  periodEnd: Date;
  earliest: number;
}

/**
 * The two dates a row starts with, read from the cells left of the Reference
 * Number column: the trans date, then the post date, whether OCR kept them
 * apart or ran them together (or ran the card's digits into the first). Null
 * when there is no row here. With ONE date readable, what else sits in that
 * zone says which it is: a garbled token before it was the trans date (the
 * row keeps its post date); one after it was the post date, and the row is
 * dated by its trans date instead (`fromTrans`); nothing garbled beside it
 * means the row printed one date, as older statements do. A date with one
 * digit wrong counts as read only where the period leaves one digit possible
 * (resolvePostDate), and then only as a post date: the trans date, which is
 * not stored, is returned as read, and only when it read as a date.
 */
function rowDates(
  cells: TextCell[],
  columns: Columns,
  window: DateWindow,
): { trans: string | null; post: string; rest: TextCell[]; fromTrans: boolean } | null {
  const zone = cells.filter((c) => c.x < columns.reference - 5).length;
  if (zone === 0) return null;
  const tokens: { text: string; cell: number; index: number; date: string | null; exact: boolean }[] = [];
  for (let cell = 0; cell < zone; cell++) {
    cells[cell].text.split(/[\s_]+/).forEach((text, index) => {
      if (text === '' || NOISE_TOKEN.test(text)) return;
      // A token shaped like a date but naming no day ("07/41") is garbled.
      const shaped = asRowDate(text);
      const exact = shaped !== null && tryRowDate(shaped, window.periodEnd) !== null ? shaped : null;
      const date = resolvePostDate(text, window.periodEnd, window.earliest) ?? exact;
      tokens.push({ text, cell, index, date, exact: exact !== null });
    });
  }
  const dates = tokens.filter((t) => t.date !== null);
  if (dates.length === 0) return null;
  let trans: (typeof tokens)[number] | null = null;
  let post: (typeof tokens)[number];
  if (dates.length >= 2) {
    [trans, post] = [dates[0], dates[1]];
  } else {
    const only = dates[0];
    // A garbled date is a short token: four bare digits are the card's
    // ending only as the first thing on the row, after that a date whose
    // slash was lost; a long token is the reference number run into the zone.
    const garbled = tokens.filter(
      (t, i) => t.date === null && t.text.length <= 6 && !(i === 0 && CARD_DIGITS.test(lookalikesToDigits(t.text))),
    );
    const after = garbled.some((t) => tokens.indexOf(t) > tokens.indexOf(only));
    if (after) {
      // The post date is unreadable. The trans date the statement printed
      // beside it dates the row instead, as a card statement with one date
      // column would (chaseCard.ts); only a date read exactly will do.
      if (!only.exact) return null;
      return { trans: null, post: asRowDate(only.text) as string, rest: cells.slice(zone), fromTrans: true };
    }
    // Nothing garbled after it: the one date the row carries (older
    // statements print one date column), or the post date beside a trans
    // date OCR garbled.
    post = only;
  }
  const rest = cells.slice(post.cell + 1);
  const leftover = cells[post.cell].text.split(/[\s_]+/).slice(post.index + 1).filter((w) => w !== '');
  if (leftover.length > 0) rest.unshift({ x: cells[post.cell].x, xEnd: cells[post.cell].xEnd, text: leftover.join(' ') });
  return { trans: trans === null || !trans.exact ? null : asRowDate(trans.text), post: post.date as string, rest, fromTrans: false };
}

/** Whether every cell of `piece` sits right of every cell of `row`, or left of all of them. */
function besideEachOther(row: TextCell[], piece: TextCell[]): boolean {
  const rowStart = Math.min(...row.map((c) => c.x));
  const rowEnd = Math.max(...row.map((c) => c.xEnd));
  return piece.every((c) => c.x >= rowEnd - 2) || piece.every((c) => c.xEnd <= rowStart + 2);
}

/**
 * OCR gives each block of a page its own baseline, so the text after a row's
 * dates can land on a line of its own a few points off. Such a piece,
 * undated, carrying no amount and beside the row's TEXT rather than over it,
 * joins the nearest dated line within NEAR_LINE. The row's amount, when it
 * sits on the row's own line, is not text: a description belongs between
 * the dates and the amount, and that gap is where it drifts from. A piece
 * carrying the row's amount as well gives up its text and keeps the amount,
 * which the column reads later. A heading, a total, a bare amount and a
 * wrapped description (further off, or under the row) pass through.
 */
function joinDriftedPieces(lines: TextLine[], columns: Columns, window: DateWindow): TextLine[] {
  const out = lines.map((l) => ({ ...l, cells: [...l.cells] }));
  const dated = (l: TextLine) => rowDates(l.cells, columns, window) !== null;
  for (let s = 0; s < out.length; s++) {
    const piece = out[s];
    if (piece.cells.length === 0 || dated(piece) || /^TOTAL\b/i.test(piece.text)) continue;
    const { text } = liftAmounts(piece, columns);
    if (text.length === 0) continue;
    let best: number | null = null;
    for (const i of [s - 1, s + 1, s - 2, s + 2]) {
      const row = out[i];
      if (row === undefined || row.cells.length === 0 || Math.abs(row.y - piece.y) > NEAR_LINE || !dated(row)) continue;
      if (!besideEachOther(liftAmounts(row, columns).text, text)) continue;
      if (best === null || Math.abs(row.y - piece.y) < Math.abs(out[best].y - piece.y)) best = i;
    }
    if (best === null) continue;
    out[best].cells = [...out[best].cells, ...text].sort((a, b) => a.x - b.x);
    out[best].text = out[best].cells.map((c) => c.text).join(' ');
    piece.cells = piece.cells.filter((c) => !text.includes(c));
    piece.text = piece.cells.map((c) => c.text).join(' ');
  }
  return out.filter((l) => l.cells.length > 0);
}

function describe(cells: TextCell[]): string {
  const words = cells
    .flatMap((c) => c.text.split(/\s+/))
    .map((w) => w.replace(/^[_=~.,:;'"|]+|[_=~.,:;'"|]+$/g, ''))
    .filter((w) => w !== '');
  if (words.length > 0 && REFERENCE.test(words[0])) words.shift();
  return words.join(' ');
}

/** A row read from the table, waiting for its amount. */
interface Draft {
  y: number;
  page: number;
  post: string | null;
  date: Date;
  description: string;
  section: Section;
}

/**
 * Gives a section's rows on one page their amounts. When the column holds as
 * many amounts as there are rows they are paired in order, whatever the
 * drift; otherwise each row takes the nearest unclaimed amount within
 * NEAR_LINE, and a row left without one refuses the statement. Amounts left
 * over are returned: a total's figure drifted into the section, or the amount
 * of a row whose dates could not be read, which the balance check will miss.
 */
function settle(drafts: Draft[], amounts: Amount[], columns: Columns, out: StatementRow[], sectionOf: Map<StatementRow, Section>): Amount[] {
  const claimed = new Set<Amount>();
  const take = (draft: Draft): Amount | null => {
    if (drafts.length === amounts.length) return amounts[drafts.indexOf(draft)];
    const free = amounts.filter((a) => !claimed.has(a) && Math.abs(a.y - draft.y) <= AMOUNT_NEAR);
    return free.sort((a, b) => Math.abs(a.y - draft.y) - Math.abs(b.y - draft.y))[0] ?? null;
  };
  for (const draft of drafts) {
    const amount = take(draft);
    if (amount === null) {
      if (draft.post === null) continue;
      throw new Error(
        `the ${draft.post} row on page ${draft.page} has no amount under Credits or Charges (the columns end at x ${Math.round(columns.credits)} and ${Math.round(columns.charges)}; its section holds ${drafts.length} rows and ${amounts.length} amounts on the page)`,
      );
    }
    claimed.add(amount);
    if (amount.amount === 0 && draft.post === null) continue;
    const row: StatementRow = { date: draft.date, description: draft.description, amount: amount.amount };
    out.push(row);
    sectionOf.set(row, draft.section);
  }
  return amounts.filter((a) => !claimed.has(a));
}

function byPageOf(lines: TextLine[]): Map<number, TextLine[]> {
  const byPage = new Map<number, TextLine[]>();
  for (const line of lines) byPage.set(line.page, [...(byPage.get(line.page) ?? []), line]);
  return byPage;
}

/** A page's place in the statement: its printed "Page N of M", read through the look-alikes; null when unreadable. */
function printedPageNumber(pageLines: TextLine[]): number | null {
  return wellsFargoCardPageHeader(pageLines).pageNo;
}

/**
 * What one page says about the statement it belongs to: the period and
 * account on every page's header, and its printed place. A scan of many
 * statements is regrouped by this (scripts/pdf-ocr.ts, scanBundle.ts). Each
 * part is null where OCR left it unreadable.
 */
export function wellsFargoCardPageHeader(pageLines: TextLine[]): PageHeader {
  const header: PageHeader = { period: null, account: null, pageNo: null, pageOf: null };
  for (const line of pageLines) {
    const p = PERIOD.exec(line.text);
    if (p !== null && header.period === null) {
      const start = parseFullDate(lookalikesToDigits(trimNoise(p[1])));
      const end = parseFullDate(lookalikesToDigits(trimNoise(p[2])));
      if (start !== null && end !== null) header.period = `${start.toISOString().slice(0, 10)}_${end.toISOString().slice(0, 10)}`;
    }
    const a = ACCOUNT.exec(line.text);
    if (a !== null && header.account === null) {
      const digits = lookalikesToDigits(a[1]);
      if (/^\d{4}$/.test(digits)) header.account = digits;
    }
    const m = PAGE_MARK.exec(line.text);
    if (m !== null && header.pageNo === null) {
      const n = Number(lookalikesToDigits(m[1]));
      const of = Number(lookalikesToDigits(m[2]));
      if (Number.isInteger(n) && n > 0 && Number.isInteger(of) && of > 0) {
        header.pageNo = n;
        header.pageOf = of;
      }
    }
  }
  return header;
}

/**
 * The pages in the statement's own order, whatever order the file holds them
 * in (a scan's sheets come as they were fed): the page with the account
 * summary first, then by printed page number where it is readable, then as
 * filed.
 */
function inStatementOrder(byPage: Map<number, TextLine[]>): [number, TextLine[]][] {
  const key = (page: number, lines: TextLine[]): number => {
    if (lines.some((l) => l.cells.some((c) => /^[^A-Za-z]*New Balance$/i.test(c.text)))) return 0;
    return (printedPageNumber(lines) ?? 50) * 1000 + page;
  };
  return [...byPage.entries()].sort((a, b) => key(a[0], a[1]) - key(b[0], b[1]));
}

/** Where a masked trace of the reading goes, when one is wanted (scripts only; never the import's path). */
export type Trace = (event: string) => void;

export const wellsFargoCard: StatementLayout = {
  id: 'wells-fargo-card',

  detect(lines) {
    const has = (pattern: RegExp) => lines.some((l) => pattern.test(l.text));
    return has(PERIOD) && has(ACCOUNT) && has(/Reference Number/i) && has(/New Balance/);
  },

  parse(lines) {
    return parseWellsFargoCard(lines);
  },
};

/**
 * The layout's reading, with an optional trace of what it did on each page:
 * headers found, rows and amounts per section, dates it could not read, in
 * positions and shapes only. For describing a refusal without the statement.
 */
export function parseWellsFargoCard(lines: TextLine[], trace: Trace = () => undefined): ReturnType<StatementLayout['parse']> {
    const periods: string[] = [];
    const accounts: string[] = [];
    for (const line of lines) {
      const p = PERIOD.exec(line.text);
      if (p !== null) {
        const start = parseFullDate(lookalikesToDigits(trimNoise(p[1])));
        const end = parseFullDate(lookalikesToDigits(trimNoise(p[2])));
        if (start !== null && end !== null) periods.push(`${start.toISOString()}|${end.toISOString()}`);
      }
      const a = ACCOUNT.exec(line.text);
      if (a !== null) {
        const digits = lookalikesToDigits(a[1]);
        if (/^\d{4}$/.test(digits)) accounts.push(digits);
      }
    }
    const period = mostCommon(periods);
    if (period === undefined) throw new Error('no statement period');
    const distinct = new Set(periods);
    if (distinct.size > 1) {
      throw new Error(`pages disagree on the statement period (${distinct.size} different periods printed)`);
    }
    const [periodStart, periodEnd] = period.split('|').map((iso) => new Date(iso));
    const last4 = mostCommon(accounts);
    if (last4 === undefined) throw new Error('no account number');

    const latest = summaryValue(lines, /^[^A-Za-z]*New Balance$/i);
    const summaryPage = inStatementOrder(byPageOf(lines))[0]?.[1] ?? [];
    const cardName = cardNameOf(summaryPage);
    // "Previous Balance", the summary's first line; OCR can spoil the word, so
    // any "... Balance" label that is not the new balance stands for it, the
    // first in reading order, and failing that the line's place in the
    // summary. The balance check catches a wrong figure.
    const previous = summaryValue(lines, /^[^A-Za-z]*(?!New\b)[A-Za-z]+ Balance\b/) ?? previousBalanceByPlace(lines);
    if (previous === null || latest === null) throw new Error('no previous or new balance in the account summary');

    const earliest = periodStart.getTime() - POSTED_BEFORE_OPENING_DAYS * 86_400_000;
    const rows: StatementRow[] = [];
    const sectionOf = new Map<StatementRow, Section>();
    const totals = new Map<Section, number>();
    let section: Section | null = null;
    let done = false;

    for (const [page, pageLines] of inStatementOrder(byPageOf(lines))) {
      if (done) break;
      // Each page's table is read under that page's own header.
      const header = tableHeader(pageLines);
      trace(`page ${page}: ${header === null ? 'no table header' : 'table header found'}`);
      if (header === null) continue;
      const { columns } = header;

      let drafts: Draft[] = [];
      let amounts: Amount[] = [];
      // Rows whose post date could not be read, waiting on the rows around
      // them: the table lists rows by post date, so one between two rows
      // posted the same day was posted that day too.
      let undated: { y: number; description: string; section: Section }[] = [];
      let lastPost: string | null = null;
      // A total whose figure drifted off its line takes the next amount near it.
      let openTotal: { key: Section; y: number } | null = null;
      const flush = (): void => {
        if (drafts.length > 0 || amounts.length > 0) {
          trace(`page ${page} ${section ?? 'no section'}: ${drafts.length} rows, ${amounts.length} amounts, paired ${drafts.length === amounts.length ? 'in order' : 'by nearness'}`);
        }
        const left = settle(drafts, amounts, columns, rows, sectionOf);
        if (openTotal !== null) {
          const near = left.find((a) => Math.abs(a.y - (openTotal as { y: number }).y) <= NEAR_LINE);
          if (near !== undefined) totals.set(openTotal.key, Math.abs(near.amount));
        }
        drafts = [];
        amounts = [];
        openTotal = null;
      };

      const window: DateWindow = { periodEnd, earliest };
      for (const line of joinDriftedPieces(pageLines.slice(header.end + 1), columns, window)) {
        // The table ends with the interest section's total; what follows (the
        // year-to-date totals, the interest charge calculation) prints money
        // under the same columns and is never a row.
        if (/Totals Year-to-Date|Interest Charge Calculation/i.test(line.text)) {
          done = true;
          break;
        }
        if (PAGE_FOOT.test(line.text) || line.cells.some((c) => PAGE_FOOT.test(c.text))) break;
        const first = line.cells[0];
        const heading = SECTIONS.find((s) => line.cells.length === 1 && s.heading.test(trimNoise(first.text)));
        if (heading !== undefined) {
          flush();
          undated = [];
          lastPost = null;
          section = heading.key;
          continue;
        }
        const { text, amounts: found } = liftAmounts(line, columns);
        for (const cell of text) {
          const under = (['credits', 'charges'] as const).find((c) => Math.abs(cell.xEnd - columns[c]) <= COLUMN_SLACK);
          if (under !== undefined) trace(`page ${page} y ${Math.round(line.y)}: under ${under} but no amount: "${shape(cell.text)}"`);
        }
        const total = SECTIONS.find((s) => s.total.test(line.text));
        if (total !== undefined) {
          flush();
          if (found.length > 0) totals.set(total.key, Math.abs(found[0].amount));
          else openTotal = { key: total.key, y: line.y };
          if (total.key === 'interest') {
            done = true;
            break;
          }
          continue;
        }
        if (/^TOTAL\b/i.test(line.text)) continue;

        if (openTotal !== null && found.length > 0 && Math.abs(found[0].y - openTotal.y) <= NEAR_LINE) {
          totals.set(openTotal.key, Math.abs(found[0].amount));
          openTotal = null;
          continue;
        }
        amounts.push(...found);

        const dates = rowDates(text, columns, window);
        if (dates === null) {
          const zone = text.filter((c) => c.x < columns.reference - 5);
          if (zone.length > 0) trace(`page ${page} y ${Math.round(line.y)}: no row dates in "${zone.map((c) => shape(c.text)).join(' | ')}"${found.length > 0 ? ', an amount beside it' : ''}`);
          else if (found.length > 0 && text.length > 0) trace(`page ${page} y ${Math.round(line.y)}: an amount beside text with no date zone, starting at x ${Math.round(text[0].x)}: "${shape(text[0].text).slice(0, 30)}"`);
          if (section !== null && UNDATED_SECTIONS.includes(section) && text.length > 0) {
            drafts.push({ y: line.y, page, post: null, date: periodEnd, description: describe(text), section });
          } else if (section !== null && zone.length > 0 && text.length > zone.length) {
            undated.push({ y: line.y, description: describe(text.slice(zone.length)), section });
          }
          continue;
        }
        if (section === null) throw new Error(`the ${dates.post} row on page ${page} comes before any section heading`);
        const date = rowDate(dates.post, periodEnd);
        if (dates.fromTrans) trace(`page ${page} y ${Math.round(line.y)}: post date unreadable, the row dated by its trans date`);
        const notBefore = dates.fromTrans ? earliest - TRANS_BEFORE_OPENING_DAYS * 86_400_000 : earliest;
        if (date.getTime() < notBefore || date > periodEnd) {
          throw new Error(`the ${dates.post} row on page ${page} is posted outside the statement period`);
        }
        // The trans date is not stored; one OCR could not make a real date of is let go.
        const trans = dates.trans === null ? null : tryRowDate(dates.trans, periodEnd);
        if (trans !== null && trans > date) {
          throw new Error(`the ${dates.post} row on page ${page} reads a transaction date after its post date`);
        }
        if (undated.length > 0 && lastPost === dates.post) {
          for (const u of undated) {
            trace(`page ${page} y ${Math.round(u.y)}: post date taken from the rows around it`);
            drafts.push({ y: u.y, page, post: dates.post, date, description: u.description, section: u.section });
          }
        }
        undated = [];
        lastPost = dates.post;
        const description = describe(dates.rest);
        if (description === '') trace(`page ${page} y ${Math.round(line.y)}: a row with no description, its cells ending at x ${line.cells.map((c) => Math.round(c.xEnd)).join(', ')}`);
        drafts.push({ y: line.y, page, post: dates.post, date, description, section });
      }
      flush();
    }

    const checks: StatementCheck[] = [];
    for (const s of SECTIONS) {
      const printed = summaryValue(lines, s.summary);
      if (printed !== null) {
        checks.push({ label: `${s.name} in the account summary`, printedCents: cents(printed), rows: (r) => sectionOf.get(r) === s.key });
      }
      const total = totals.get(s.key);
      if (total !== undefined) {
        checks.push({ label: `${s.name} total for this period`, printedCents: cents(total), rows: (r) => sectionOf.get(r) === s.key });
      }
    }

    return [
      {
        layout: 'wells-fargo-card',
        institution: 'Wells Fargo',
        accountType: 'CREDIT',
        accountLast4: last4,
        ...(cardName === null ? {} : { cardName }),
        periodStart,
        periodEnd,
        // A balance owed prints positive; the app stores it negative.
        openingBalance: -previous,
        closingBalance: -latest,
        rows,
        checks,
      },
    ];
}
