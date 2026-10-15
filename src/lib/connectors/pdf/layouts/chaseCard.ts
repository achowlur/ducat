import type { TextCell, TextLine } from '../lines';
import {
  cents,
  rowDate,
  parseFullDate,
  parseMoney,
  splitTrailingAmount,
  type StatementCheck,
  type StatementLayout,
  type StatementRow,
} from '../statement';

/**
 * Chase credit card statements.
 *
 * Page one's account summary prints the previous and new balance, the
 * opening/closing dates, and one total per kind of activity. The account
 * activity table lists rows under section headings (PAYMENTS AND OTHER
 * CREDITS, PURCHASE, FEES CHARGED, INTEREST CHARGED...) in a single amount
 * column: a purchase prints positive, a payment or credit negative, the
 * reverse of the app's signs (src/types/contracts.ts), so every row and
 * balance is negated.
 *
 * Each section must add up to its line in the summary. Lines with no date
 * inside the table are exchange-rate and airline-ticket details belonging to
 * the row above, and carry no amount; they are skipped, since no other
 * source puts them in a description either.
 */

const ROW_DATE = /^\d{1,2}\/\d{1,2}$/;
/** How far a row's amount may sit from the "$ Amount" header's right edge. */
const COLUMN_SLACK = 15;
/** A row's date sits at the table's left margin; anything dated further right is not a row. */
const DATE_MAX_X = 80;

type Section = 'payments' | 'purchases' | 'cashAdvances' | 'balanceTransfers' | 'fees' | 'interest';

const SECTION_HEADINGS: [RegExp, Section][] = [
  [/^PAYMENTS AND OTHER CREDITS$/i, 'payments'],
  [/^PURCHASES?$/i, 'purchases'],
  [/^CASH ADVANCES?$/i, 'cashAdvances'],
  [/^BALANCE TRANSFERS?$/i, 'balanceTransfers'],
  [/^FEES CHARGED$/i, 'fees'],
  [/^INTEREST CHARGED$/i, 'interest'],
];

const SUMMARY_LINES: [RegExp, Section, string][] = [
  [/^Payments?, Credits$/i, 'payments', 'payments and credits'],
  [/^Purchases$/i, 'purchases', 'purchases'],
  [/^Cash Advances$/i, 'cashAdvances', 'cash advances'],
  [/^Balance Transfers/i, 'balanceTransfers', 'balance transfers'],
  [/^Fees Charged$/i, 'fees', 'fees charged'],
  [/^Interest Charged$/i, 'interest', 'interest charged'],
];

function cellMatching(line: TextLine, pattern: RegExp): TextCell | undefined {
  return line.cells.find((c) => pattern.test(c.text));
}

/** The amount printed after a labelled cell on its line, searching every line; null when none carries one. */
function summaryValue(lines: TextLine[], label: RegExp): number | null {
  for (const line of lines) {
    const cell = cellMatching(line, label);
    if (cell === undefined) continue;
    for (const after of line.cells.slice(line.cells.indexOf(cell) + 1)) {
      const value = parseMoney(after.text);
      if (value !== null) return value;
    }
  }
  return null;
}

export const chaseCard: StatementLayout = {
  id: 'chase-card',

  detect(lines) {
    const has = (pattern: RegExp) => lines.some((l) => pattern.test(l.text));
    return has(/chase/i) && has(/Opening\/Closing Date/i) && has(/Merchant Name or Transaction Description/i);
  },

  parse(lines) {
    let periodStart: Date | null = null;
    let periodEnd: Date | null = null;
    for (const line of lines) {
      const label = cellMatching(line, /^Opening\/Closing Date$/i);
      const value = label && line.cells[line.cells.indexOf(label) + 1]?.text;
      const m = value ? /^(\S+)\s*-\s*(\S+)$/.exec(value) : null;
      if (m !== null) {
        periodStart = parseFullDate(m[1]);
        periodEnd = parseFullDate(m[2]);
        break;
      }
    }
    if (periodStart === null || periodEnd === null) throw new Error('no opening/closing date');

    const accountCell = lines.map((l) => cellMatching(l, /^Account Number:/i)).find((c) => c !== undefined);
    const last4 = accountCell ? /(\d{4})$/.exec(accountCell.text)?.[1] : undefined;
    if (last4 === undefined) throw new Error('no account number');

    const previous = summaryValue(lines, /^Previous Balance$/i);
    const latest = summaryValue(lines, /^New Balance$/i);
    if (previous === null || latest === null) throw new Error('no previous or new balance in the account summary');

    const rows: StatementRow[] = [];
    const sectionOf = new Map<StatementRow, Section>();
    let amountX: number | null = null;
    let section: Section | null = null;
    for (const line of lines) {
      if (/Totals Year-to-Date/i.test(line.text)) break;
      const header = cellMatching(line, /^Merchant Name or Transaction Description$/i);
      if (header !== undefined) {
        amountX = cellMatching(line, /Amount$/i)?.xEnd ?? null;
        if (amountX === null) throw new Error('the activity table has no amount column');
        continue;
      }
      if (amountX === null) continue;

      const first = line.cells[0];
      const heading = SECTION_HEADINGS.find(([pattern]) => line.cells.length === 1 && pattern.test(first.text));
      if (heading !== undefined) {
        section = heading[1];
        continue;
      }
      if (!ROW_DATE.test(first.text) || first.x > DATE_MAX_X) continue;

      const cells = splitTrailingAmount(line.cells, amountX, COLUMN_SLACK);
      const last = cells[cells.length - 1];
      const printed = cells.length > 2 ? parseMoney(last.text) : null;
      if (printed === null || Math.abs(last.xEnd - amountX) > COLUMN_SLACK) {
        // Positions and a SHAPE only (letters as X, digits as #): they say what
        // went wrong without saying what was bought or for how much.
        const ends = cells.map((c) => Math.round(c.xEnd)).join(', ');
        const shape = last.text.replace(/[A-Z]/g, 'X').replace(/[a-z]/g, 'x').replace(/\d/g, '#');
        throw new Error(
          `the ${first.text} row has no amount in the amount column (its text ends at x ${ends}; the column ends at x ${Math.round(amountX)}; its last piece reads "${shape}")`,
        );
      }
      if (section === null) throw new Error(`the ${first.text} row comes before any section heading`);
      const row: StatementRow = {
        date: rowDate(first.text, periodEnd),
        description: cells.slice(1, -1).map((c) => c.text).join(' '),
        amount: -printed,
      };
      rows.push(row);
      sectionOf.set(row, section);
    }

    const checks: StatementCheck[] = [];
    for (const [label, key, name] of SUMMARY_LINES) {
      const printed = summaryValue(lines, label);
      if (printed === null) continue;
      checks.push({ label: `${name} in the account summary`, printedCents: cents(printed), rows: (r) => sectionOf.get(r) === key });
    }

    return {
      layout: 'chase-card',
      institution: 'Chase',
      accountType: 'CREDIT',
      accountLast4: last4,
      periodStart,
      periodEnd,
      // A balance owed prints positive; the app stores it negative.
      openingBalance: -previous,
      closingBalance: -latest,
      rows,
      checks,
    };
  },
};
