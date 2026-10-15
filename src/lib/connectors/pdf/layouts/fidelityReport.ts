import type { TextLine } from '../lines';
import {
  cents,
  parseLongDate,
  parseMoney,
  rowDate,
  splitTrailingAmount,
  type ParsedStatement,
  type StatementCheck,
  type StatementLayout,
  type StatementRow,
} from '../statement';

/**
 * Fidelity's Investment Report: ONE file for every account the holder has,
 * each account in its own section headed "Account # X00-000000" on every page.
 *
 * What is read per account is what the import keeps for an investment
 * account: its value (the Account Summary's beginning and ending value, the
 * ending one becoming a snapshot) and money crossing the account's boundary
 * (the rows of a section such as Deposits). Trades, dividends, reinvestments
 * and core-fund sweeps stay inside the account and are not read at all.
 *
 * The check: beginning value + every money-in/out row + the printed change in
 * investment value = ending value, to the cent; and each money-flow line of
 * the summary equals the rows of its section. A summary line moving money this
 * period whose section this parser does not read REFUSES the statement, naming
 * the line, rather than leaving that money out.
 */

const PERIOD = /([A-Za-z]{3,9}\.? \d{1,2}, \d{4})\s*-\s*([A-Za-z]{3,9}\.? \d{1,2}, \d{4})/;
const ACCOUNT = /^Account #\s*([A-Z0-9]+-\d+)$/i;
const ROW_DATE = /^\d{1,2}\/\d{1,2}$/;
/** How far a figure's right edge may sit from its column header's. */
const SLACK = 12;
/** The account summary is the page's LEFT half; the right half holds charts and income. */
const SUMMARY_MAX_X = 400;
/** A summary label sits at the margin, a breakdown line under it a few points in. */
const LABEL_MAX_X = 100;
const BREAKDOWN_MIN_X = 53;
/** Where a wrapped description line starts; page headers sit further right. */
const CONTINUATION_X: [number, number] = [290, 520];

/** The money-flow sections this parser reads, by the summary line naming them. */
const FLOW_SECTIONS = new Set(['deposits', 'withdrawals']);

interface AccountLines {
  number: string;
  lines: TextLine[];
}

interface Breakdown {
  name: string;
  value: number;
  /** +1 under Additions, -1 under Subtractions. */
  sign: 1 | -1;
}

/** Each account's lines, in page order, keyed by the number its pages print. */
function byAccount(lines: TextLine[]): AccountLines[] {
  const groups: AccountLines[] = [];
  let current: AccountLines | null = null;
  for (const line of lines) {
    const header = line.cells.map((c) => ACCOUNT.exec(c.text)).find((m) => m !== null);
    if (header != null) {
      current = groups.find((g) => g.number === header[1]) ?? null;
      if (current === null) {
        current = { number: header[1], lines: [] };
        groups.push(current);
      }
      continue;
    }
    current?.lines.push(line);
  }
  return groups;
}

/** The right edge of the account summary's "This Period" column. */
function thisPeriodColumn(lines: TextLine[]): number | null {
  for (const line of lines) {
    const cell = line.cells.find((c) => c.text === 'This Period' && c.x < SUMMARY_MAX_X);
    if (cell !== undefined) return cell.xEnd;
  }
  return null;
}

/** A summary line's This Period figure; a printed "-" is zero. */
function figure(line: TextLine, column: number): number | null {
  const cell = line.cells.slice(1).find((c) => c.x < SUMMARY_MAX_X && Math.abs(c.xEnd - column) <= SLACK);
  if (cell === undefined) return null;
  if (cell.text === '-') return 0;
  const value = parseMoney(cell.text);
  if (value === null) throw new Error(`"${line.cells[0].text}" has no readable figure`);
  return value;
}

function summary(lines: TextLine[], column: number) {
  let opening: number | null = null;
  let closing: number | null = null;
  let market: number | null = null;
  let additions = 0;
  let subtractions = 0;
  const breakdown: Breakdown[] = [];
  let under: 1 | -1 | null = null;
  for (const line of lines) {
    const first = line.cells[0];
    if (first === undefined || first.x > LABEL_MAX_X) continue;
    const label = first.text;
    if (opening === null) {
      if (/^Beginning Account Value$/i.test(label)) opening = figure(line, column);
      continue;
    }
    if (/^Ending Account Value$/i.test(label)) {
      closing = figure(line, column);
      break;
    }
    if (/^Additions$/i.test(label)) {
      additions = figure(line, column) ?? 0;
      under = 1;
    } else if (/^Subtractions$/i.test(label)) {
      subtractions = figure(line, column) ?? 0;
      under = -1;
    } else if (/^Change in Investment Value\b/i.test(label)) {
      market = figure(line, column);
      under = null;
    } else if (under !== null && first.x >= BREAKDOWN_MIN_X) {
      const value = figure(line, column);
      if (value !== null) breakdown.push({ name: label, value, sign: under });
    }
  }
  return { opening, closing, market, additions, subtractions, breakdown };
}

/** The rows of one money-flow section ("Deposits" ... "Total Deposits"). */
function section(lines: TextLine[], name: string) {
  const heading = lines.findIndex(
    (l) => l.cells.length === 1 && l.cells[0].x <= LABEL_MAX_X && l.cells[0].text.toLowerCase() === name.toLowerCase(),
  );
  if (heading === -1) return null;
  let amountX: number | null = null;
  let total: number | null = null;
  const rows: { dateText: string; description: string[]; amount: number }[] = [];
  for (const line of lines.slice(heading + 1)) {
    const first = line.cells[0];
    if (amountX === null) {
      if (line.cells.some((c) => c.text === 'Date')) amountX = line.cells.find((c) => c.text === 'Amount')?.xEnd ?? null;
      continue;
    }
    if (new RegExp(`^Total ${name}$`, 'i').test(first.text)) {
      total = parseMoney(line.cells[line.cells.length - 1].text);
      break;
    }
    if (ROW_DATE.test(first.text) && first.x <= LABEL_MAX_X) {
      const cells = splitTrailingAmount(line.cells, amountX, SLACK);
      const last = cells[cells.length - 1];
      const amount = cells.length > 1 && Math.abs(last.xEnd - amountX) <= SLACK ? parseMoney(last.text) : null;
      if (amount === null) throw new Error(`the ${first.text} ${name.toLowerCase()} row has no amount`);
      rows.push({ dateText: first.text, description: cells.slice(1, -1).map((c) => c.text), amount });
    } else if (rows.length > 0 && first.x >= CONTINUATION_X[0] && first.x <= CONTINUATION_X[1] && line.cells.every((c) => parseMoney(c.text) === null)) {
      rows[rows.length - 1].description.push(line.text);
    }
  }
  if (amountX === null) throw new Error(`the ${name} section has no amount column`);
  if (total === null) throw new Error(`the ${name} section has no total`);
  return { rows, total };
}

export const fidelityReport: StatementLayout = {
  id: 'fidelity-report',

  detect(lines) {
    const has = (pattern: RegExp) => lines.some((l) => pattern.test(l.text));
    return has(/fidelity/i) && has(/investment report/i) && has(/^Beginning Account Value/i);
  },

  parse(lines) {
    const period = lines.map((l) => PERIOD.exec(l.text)).find((m) => m !== null);
    const periodStart = period ? parseLongDate(period[1]) : null;
    const periodEnd = period ? parseLongDate(period[2]) : null;
    if (periodStart === null || periodEnd === null) throw new Error('no statement period');

    const statements: ParsedStatement[] = [];
    for (const account of byAccount(lines)) {
      const column = thisPeriodColumn(account.lines);
      if (column === null) continue; // pages with no account summary of their own
      const s = summary(account.lines, column);
      if (s.opening === null || s.closing === null || s.market === null) {
        throw new Error(`account ${account.number}: the summary lacks its beginning, ending or change in value`);
      }

      const rows: StatementRow[] = [];
      const sectionOf = new Map<StatementRow, string>();
      const checks: StatementCheck[] = [];
      for (const line of s.breakdown) {
        if (line.value === 0) continue;
        const name = line.name.toLowerCase();
        const read = FLOW_SECTIONS.has(name) ? section(account.lines, line.name) : null;
        if (read === null) {
          throw new Error(
            `account ${account.number} shows "${line.name}" this period, and this import does not read that section yet`,
          );
        }
        for (const r of read.rows) {
          const row: StatementRow = {
            date: rowDate(r.dateText, periodEnd),
            description: r.description.join(' '),
            amount: line.sign * Math.abs(r.amount),
          };
          rows.push(row);
          sectionOf.set(row, name);
        }
        checks.push(
          { label: `${line.name} in the account summary`, printedCents: cents(line.value), rows: (r) => sectionOf.get(r) === name },
          { label: `Total ${line.name}`, printedCents: cents(read.total), rows: (r) => sectionOf.get(r) === name },
        );
      }
      checks.push(
        { label: 'additions in the account summary', printedCents: cents(s.additions), rows: (r) => r.amount > 0 },
        { label: 'subtractions in the account summary', printedCents: cents(s.subtractions), rows: (r) => r.amount < 0 },
      );

      statements.push({
        layout: 'fidelity-report',
        institution: 'Fidelity',
        accountType: 'INVESTMENT',
        accountLast4: account.number.replace(/\D/g, '').slice(-4),
        periodStart,
        periodEnd,
        openingBalance: s.opening,
        closingBalance: s.closing,
        marketChange: s.market,
        rows,
        checks,
      });
    }
    return statements;
  },
};
