import type { TextCell, TextLine } from '../lines';
import {
  cents,
  rowDate,
  noonUtc,
  parseLongDate,
  parseMoney,
  type StatementCheck,
  type StatementLayout,
  type StatementRow,
} from '../statement';

/**
 * Wells Fargo checking and savings statements.
 *
 * The statement carries its period (see statementPeriod: older ones print it
 * whole, newer ones only the statement date) and an activity summary:
 * beginning balance, deposits, withdrawals, ending balance.
 * The transaction history is a table whose amounts carry NO sign: a number is
 * a deposit or a withdrawal by the column it sits in, so the columns are found
 * from the table's own header row rather than from fixed positions, and every
 * amount must sit under one of them or the statement is refused.
 *
 * Three independent checks come out of one statement: the summary's deposit
 * and withdrawal totals, the table's Totals row, and the ending daily balance
 * printed on each day's last row. A row read into the wrong column cannot
 * pass all three.
 */

const ROW_DATE = /^\d{1,2}\/\d{1,2}$/;
const PERIOD = /([A-Za-z]{3,9}\.? \d{1,2}, \d{4})\s*-\s*([A-Za-z]{3,9}\.? \d{1,2}, \d{4})/;
const LEADING_DATE = /^([A-Za-z]{3,9}\.? \d{1,2}, \d{4})(?!\d)/;
/** How far an amount's right edge may sit from its column header's. */
const COLUMN_SLACK = 15;
/** Text starting left of this is a page header or footer, never a wrapped description. */
const DESCRIPTION_MIN_X = 100;

interface Columns {
  deposits: number;
  withdrawals: number;
  daily: number | null;
}

interface DraftRow {
  dateText: string;
  description: string[];
  deposit: number | null;
  withdrawal: number | null;
  daily: number | null;
}

function cellMatching(line: TextLine, pattern: RegExp): TextCell | undefined {
  return line.cells.find((c) => pattern.test(c.text));
}

/** The first amount printed after a labelled cell on the same line. */
function amountAfter(line: TextLine, label: TextCell): number | null {
  for (const cell of line.cells.slice(line.cells.indexOf(label) + 1)) {
    const value = parseMoney(cell.text);
    if (value !== null) return value;
  }
  return null;
}

function summaryValue(lines: TextLine[], label: RegExp, name: string): number {
  for (const line of lines) {
    const cell = cellMatching(line, label);
    if (cell === undefined) continue;
    const value = amountAfter(line, cell);
    if (value !== null) return value;
  }
  throw new Error(`no ${name} in the activity summary`);
}

/** The MM/DD a "Beginning balance on 12/8" or "Ending balance on 1/9" label ends in. */
function labelDay(lines: TextLine[], label: RegExp): [number, number] {
  for (const line of lines) {
    const m = /on (\d{1,2})\/(\d{1,2})$/.exec(cellMatching(line, label)?.text ?? '');
    if (m !== null) return [Number(m[1]), Number(m[2])];
  }
  throw new Error('no statement period');
}

/**
 * Older statements print the period whole ("December 8, 2018 - January 9,
 * 2019"). Newer ones print only the statement date on each page, so the
 * period's days come from the summary's beginning and ending balance labels
 * and its year from that date, stepping back a year where the days cross one.
 */
function statementPeriod(lines: TextLine[]): { periodStart: Date; periodEnd: Date } {
  for (const line of lines) {
    const m = PERIOD.exec(line.text);
    const start = m ? parseLongDate(m[1]) : null;
    const end = m ? parseLongDate(m[2]) : null;
    if (start !== null && end !== null) return { periodStart: start, periodEnd: end };
  }
  // The date can share its cell with the page marker beside it ("June 9, 2020
  // n Page 1 of 3"), so it is read from the START of a cell; one mid-sentence
  // ("as of October 1, 2026, ...") never counts.
  const statementDate = lines
    .flatMap((l) => l.cells)
    .map((c) => {
      const m = LEADING_DATE.exec(c.text);
      return m === null ? null : parseLongDate(m[1]);
    })
    .find((d) => d !== null);
  if (statementDate == null) throw new Error('no statement period or statement date');
  const [endMonth, endDay] = labelDay(lines, /^Ending balance on/i);
  const [startMonth, startDay] = labelDay(lines, /^Beginning balance on/i);
  const endYear = statementDate.getUTCFullYear() - (endMonth > statementDate.getUTCMonth() + 1 ? 1 : 0);
  const periodEnd = noonUtc(endYear, endMonth, endDay);
  const start = noonUtc(endYear, startMonth, startDay);
  return { periodStart: start > periodEnd ? noonUtc(endYear - 1, startMonth, startDay) : start, periodEnd };
}

function columnsFrom(header: TextLine, above: TextLine | undefined): Columns {
  const edge = (pattern: RegExp) => (cellMatching(header, pattern) ?? (above && cellMatching(above, pattern)))?.xEnd;
  const deposits = edge(/additions|deposits/i);
  const withdrawals = edge(/subtractions|withdrawals/i);
  if (deposits === undefined || withdrawals === undefined) throw new Error('the transaction table has no deposit or withdrawal column');
  return { deposits, withdrawals, daily: edge(/balance/i) ?? null };
}

function column(cell: TextCell, columns: Columns): keyof Columns | null {
  const candidates = (Object.entries(columns) as [keyof Columns, number | null][])
    .filter(([, x]) => x !== null && Math.abs(cell.xEnd - x) <= COLUMN_SLACK)
    .sort((a, b) => Math.abs(cell.xEnd - (a[1] as number)) - Math.abs(cell.xEnd - (b[1] as number)));
  return candidates[0]?.[0] ?? null;
}

export const wellsFargoDeposit: StatementLayout = {
  id: 'wells-fargo-deposit',

  detect(lines) {
    const has = (pattern: RegExp) => lines.some((l) => pattern.test(l.text));
    return has(/wells\s*fargo/i) && has(/^Transaction history/i) && has(/Beginning balance on/i);
  },

  parse(lines) {
    const { periodStart, periodEnd } = statementPeriod(lines);

    const accountNumber = lines.map((l) => /Account number:\s*(\d{4,})/i.exec(l.text)).find((m) => m !== null);
    if (accountNumber == null) throw new Error('no account number');

    const openingBalance = summaryValue(lines, /^Beginning balance on/i, 'beginning balance');
    const closingBalance = summaryValue(lines, /^Ending balance on/i, 'ending balance');
    const summaryDeposits = summaryValue(lines, /^Deposits\/\s*Additions$/i, 'deposits total');
    const summaryWithdrawals = summaryValue(lines, /^Withdrawals\/\s*Subtractions$/i, 'withdrawals total');

    // The table: from its header row to the Totals row.
    const headerIndex = lines.findIndex((l) => cellMatching(l, /additions/i) && cellMatching(l, /subtractions/i));
    if (headerIndex === -1) throw new Error('no transaction table header');
    const columns = columnsFrom(lines[headerIndex], lines[headerIndex - 1]);

    const drafts: DraftRow[] = [];
    let tableEnding: number | null = null;
    let totals: { deposits: number | null; withdrawals: number | null } | null = null;
    for (const line of lines.slice(headerIndex + 1)) {
      const first = line.cells[0];
      if (/^Totals$/i.test(first.text)) {
        totals = { deposits: null, withdrawals: null };
        for (const cell of line.cells.slice(1)) {
          const value = parseMoney(cell.text);
          const at = column(cell, columns);
          if (value === null || at === null || at === 'daily') continue;
          totals[at] = value;
        }
        break;
      }
      if (/^Ending balance on/i.test(first.text)) {
        tableEnding = amountAfter(line, first);
        continue;
      }
      // A repeated header on a later page.
      if (cellMatching(line, /additions/i) && cellMatching(line, /subtractions/i)) continue;

      const startsRow = ROW_DATE.test(first.text);
      if (!startsRow && (first.x < DESCRIPTION_MIN_X || drafts.length === 0)) continue;
      const row: DraftRow = startsRow
        ? { dateText: first.text, description: [], deposit: null, withdrawal: null, daily: null }
        : drafts[drafts.length - 1];
      if (startsRow) drafts.push(row);

      for (const cell of startsRow ? line.cells.slice(1) : line.cells) {
        const value = parseMoney(cell.text);
        const at = value === null ? null : column(cell, columns);
        if (value === null) {
          row.description.push(cell.text);
        } else if (at === null) {
          throw new Error(`an amount (${row.dateText} row) sits under no column`);
        } else if (at === 'deposits') {
          row.deposit = value;
        } else if (at === 'withdrawals') {
          row.withdrawal = value;
        } else {
          row.daily = value;
        }
      }
    }

    if (tableEnding !== null && cents(tableEnding) !== cents(closingBalance)) {
      throw new Error('the table and the summary disagree on the ending balance');
    }

    const rows: StatementRow[] = [];
    const checks: StatementCheck[] = [];
    for (const draft of drafts) {
      if ((draft.deposit === null) === (draft.withdrawal === null)) {
        throw new Error(`the ${draft.dateText} row has ${draft.deposit === null ? 'no amount' : 'two amounts'}`);
      }
      const row: StatementRow = {
        date: rowDate(draft.dateText, periodEnd),
        description: draft.description.join(' '),
        amount: draft.deposit !== null ? Math.abs(draft.deposit) : -Math.abs(draft.withdrawal as number),
      };
      rows.push(row);
      if (draft.daily !== null) {
        const upTo = new Set(rows);
        checks.push({
          label: `ending daily balance after the ${draft.dateText} row`,
          printedCents: cents(draft.daily) - cents(openingBalance),
          rows: (r) => upTo.has(r),
          signed: true,
        });
      }
    }

    checks.push(
      { label: 'deposits in the summary', printedCents: cents(summaryDeposits), rows: (r) => r.amount > 0 },
      { label: 'withdrawals in the summary', printedCents: cents(summaryWithdrawals), rows: (r) => r.amount < 0 },
    );
    if (totals?.deposits != null) {
      checks.push({ label: 'deposits in the Totals row', printedCents: cents(totals.deposits), rows: (r) => r.amount > 0 });
    }
    if (totals?.withdrawals != null) {
      checks.push({ label: 'withdrawals in the Totals row', printedCents: cents(totals.withdrawals), rows: (r) => r.amount < 0 });
    }

    return {
      layout: 'wells-fargo-deposit',
      institution: 'Wells Fargo',
      accountType: 'DEPOSITORY',
      accountLast4: accountNumber[1].slice(-4),
      periodStart,
      periodEnd,
      openingBalance,
      closingBalance,
      rows,
      checks,
    };
  },
};
