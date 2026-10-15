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
 * (every line under Additions or Subtractions, read through the section of the
 * same name, or an exchange through its "Transferred From/To" rows). Trades,
 * dividends, reinvestments and core-fund sweeps stay inside the account, in the
 * change in investment value, and are not read at all; so do the costs it pays
 * inside itself, a fee or a trade's transaction cost.
 *
 * The check: beginning value + every money-in/out row + the printed change in
 * investment value + the printed costs = ending value, to the cent; and each
 * line of the summary equals the rows of its section and that section's
 * printed total. A line moving money this period with no rows listing it
 * REFUSES the statement, naming the line, rather than leaving that money out.
 *
 * Positions are read RELATIVE to the page's own headings: where a report sets
 * its summary moves between reports (the first real run met the same summary
 * 18 points further left than the layout dump it was written from).
 */

/** Fidelity's year-end report: one summary of the whole year, beside that December's monthly report. */
const YEAR_END = /\bYEAR-END INVESTMENT REPORT\b/i;
const PERIOD = /([A-Za-z]{3,9}\.? \d{1,2}, \d{4})\s*-\s*([A-Za-z]{3,9}\.? \d{1,2}, \d{4})/;
const ACCOUNT = /^Account #\s*([A-Z0-9]+-\d+)$/i;
const ROW_DATE = /^\d{1,2}\/\d{1,2}$/;
/** How far a figure's right edge may sit from its column header's. */
const SLACK = 12;
/** The account summary is the page's LEFT half; the right half holds charts and income. */
const SUMMARY_MAX_X = 400;
/** A summary label sits at the left margin. */
const LABEL_MAX_X = 100;
/** A line under Additions or Subtractions is set in from the heading (by about 9 points). */
const INDENT = 4;
/**
 * Costs paid inside the account (an advisory fee, a trade's transaction
 * cost): what its value did, like the market, and never a row. Ducat counts an
 * advisory fee inside an investment account the same way (netWorth.ts).
 */
const COSTS = /\b(fees?|charges|costs?)\b/i;
/** Money moved between the holder's own accounts, which may have no section of its own. */
const EXCHANGE = /^Exchanges (In|Out)$/i;
/**
 * A summary heading of its own beside Additions and Subtractions: securities
 * moved IN KIND between the holder's accounts, whose activity rows carry a
 * quantity and no amount, so only the summary prints what they were worth.
 */
const IN_KIND = /^Transfers Between\b.*\bAccounts$/i;

interface AccountLines {
  number: string;
  lines: TextLine[];
}

interface Breakdown {
  name: string;
  value: number;
  /** +1 under Additions or in, -1 under Subtractions or out. */
  sign: 1 | -1;
  /** A heading of its own (an in-kind transfer), not a line under one. */
  heading?: true;
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

const at = (cell: { x: number; xEnd: number }) => `x ${Math.round(cell.x)}-${Math.round(cell.xEnd)}`;
const money = (n: number) => n.toFixed(2);
const quoted = (labels: string[]) => labels.map((l) => `"${l}"`).join(', ');

/**
 * The account summary, from its beginning value to its ending value. Every
 * line in between that prints a figure this period is placed: Additions or
 * Subtractions, a line under one of them, or the change in investment value.
 * A figure with no place refuses the statement, naming the line, and so does
 * a heading its own lines do not add up to: money the summary moves is never
 * left out unseen.
 */
function summary(lines: TextLine[], column: number, account: string) {
  let opening: number | null = null;
  let closing: number | null = null;
  let market: number | null = null;
  let begun = false;
  /** An account with nothing but a balance prints no change-in-value line at all. */
  let changeLine = false;
  let headingX = 0;
  let additions = 0;
  let subtractions = 0;
  const breakdown: Breakdown[] = [];
  /** The labels read after the beginning value, for a refusal to name. */
  const labels: string[] = [];
  let under: 1 | -1 | null = null;
  for (const line of lines) {
    const first = line.cells[0];
    if (first === undefined || first.x > LABEL_MAX_X) continue;
    const label = first.text;
    if (!begun) {
      if (/^Beginning Account Value$/i.test(label)) {
        begun = true;
        opening = figure(line, column);
      }
      continue;
    }
    labels.push(label);
    const value = figure(line, column);
    if (/^Ending Account Value$/i.test(label)) {
      closing = value;
      break;
    }
    if (/^Additions$/i.test(label)) {
      additions = value ?? 0;
      under = 1;
      headingX = first.x;
    } else if (/^Subtractions$/i.test(label)) {
      subtractions = value ?? 0;
      under = -1;
      headingX = first.x;
    } else if (/^Change in Investment Value\b/i.test(label)) {
      changeLine = true;
      market = value;
      under = null;
    } else if (IN_KIND.test(label)) {
      if (value !== null && value !== 0) breakdown.push({ name: label, value, sign: value < 0 ? -1 : 1, heading: true });
      under = null;
    } else if (value !== null) {
      if (under === null || first.x < headingX + INDENT) {
        throw new Error(
          `account ${account}: the summary line "${label}" (${at(first)}) prints a figure this period but is not a line under Additions or Subtractions`,
        );
      }
      breakdown.push({ name: label, value, sign: under });
    }
  }

  const missing = [
    [opening === null, 'beginning value'],
    [closing === null, 'ending value'],
    [changeLine && market === null, 'change in investment value'],
  ]
    .filter(([absent]) => absent)
    .map(([, what]) => what);
  if (missing.length > 0) {
    throw new Error(
      `account ${account}: the summary has no ${missing.join(' or ')} in the This Period column (ending at x ${Math.round(column)}); it reads: ${labels.length > 0 ? quoted(labels) : begun ? 'nothing after the beginning value' : 'no "Beginning Account Value" line'}`,
    );
  }

  // A heading's own lines must add up to it before any section is read.
  for (const [heading, printed, sign] of [
    ['Additions', additions, 1],
    ['Subtractions', subtractions, -1],
  ] as const) {
    const read = breakdown.filter((b) => b.sign === sign && b.heading !== true);
    const sum = read.reduce((total, b) => total + Math.abs(cents(b.value)), 0);
    if (sum !== Math.abs(cents(printed))) {
      const named = read.length > 0 ? read.map((b) => `"${b.name}" ${money(b.value)}`).join(', ') : 'none';
      throw new Error(
        `account ${account}: the lines read under ${heading} (${named}) add up to ${money(sum / 100)}, but ${heading} prints ${money(printed)}; it reads: ${quoted(labels)}`,
      );
    }
  }
  return { opening: opening as number, closing: closing as number, market: market ?? 0, additions, subtractions, breakdown };
}

/**
 * The rows of one money-flow section, headed by the summary line's own label
 * ("Deposits" ... "Total Deposits"). A wrapped description continues under the
 * Description column.
 */
function section(lines: TextLine[], name: string) {
  const heading = lines.findIndex(
    (l) => l.cells.length === 1 && l.cells[0].x <= LABEL_MAX_X && l.cells[0].text.toLowerCase() === name.toLowerCase(),
  );
  if (heading === -1) return null;
  let amountX: number | null = null;
  let descriptionX: number | null = null;
  let total: number | null = null;
  const totalLine = new RegExp(`^Total ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const rows: { dateText: string; description: string[]; amount: number }[] = [];
  for (const line of lines.slice(heading + 1)) {
    const first = line.cells[0];
    if (amountX === null) {
      if (line.cells.some((c) => c.text === 'Date')) {
        amountX = line.cells.find((c) => c.text === 'Amount')?.xEnd ?? null;
        descriptionX = line.cells.find((c) => c.text === 'Description')?.x ?? null;
      }
      continue;
    }
    if (totalLine.test(first.text)) {
      // The figure under Amount: a page can set a mark of its own past it.
      const amountEnd = amountX;
      const figureCell = line.cells.find((c) => c !== first && Math.abs(c.xEnd - amountEnd) <= SLACK);
      total = figureCell === undefined ? null : parseMoney(figureCell.text);
      break;
    }
    if (ROW_DATE.test(first.text) && first.x <= LABEL_MAX_X) {
      // Past the Amount column is page furniture: an edge mark, the footer's code.
      const amountEnd = amountX;
      const cells = splitTrailingAmount(
        line.cells.filter((c) => c.x < amountEnd),
        amountEnd,
        SLACK,
      );
      const last = cells[cells.length - 1];
      const amount = cells.length > 1 && Math.abs(last.xEnd - amountX) <= SLACK ? parseMoney(last.text) : null;
      if (amount === null) throw new Error(`the ${first.text} ${name.toLowerCase()} row has no amount`);
      // A "-" holds an empty quantity or price column.
      const words = cells.slice(1, -1).filter((c) => c.text !== '-');
      rows.push({ dateText: first.text, description: words.map((c) => c.text), amount });
    } else if (
      rows.length > 0 &&
      descriptionX !== null &&
      Math.abs(first.x - descriptionX) <= SLACK &&
      line.cells.every((c) => parseMoney(c.text) === null)
    ) {
      rows[rows.length - 1].description.push(line.text);
    }
  }
  if (amountX === null) throw new Error(`the ${name} section has no amount column`);
  if (total === null) throw new Error(`the ${name} section has no total`);
  return { rows, total };
}

/**
 * An exchange listed as a row of the account's activity table rather than a
 * section of its own: "Transferred From" coming in, "Transferred To" going
 * out, with the other account's number in the security-name column. A long
 * name can run into the Date column and carry the date at its end. Null when
 * no such row is listed. There is no printed total; the summary line is the
 * check.
 */
function transferRows(lines: TextLine[], direction: 'From' | 'To') {
  const verb = new RegExp(`^Transferred ${direction}$`, 'i');
  let amountX: number | null = null;
  const rows: { dateText: string; description: string[]; amount: number }[] = [];
  for (const line of lines) {
    if (line.cells.some((c) => c.text === 'Transaction Description')) {
      amountX = line.cells.find((c) => c.text === 'Amount')?.xEnd ?? null;
      continue;
    }
    const verbAt = line.cells.findIndex((c) => verb.test(c.text));
    if (verbAt === -1) continue;
    const amountEnd = amountX;
    const before = line.cells.slice(0, verbAt);
    const dateCell = before.find((c) => ROW_DATE.test(c.text));
    const merged = dateCell === undefined ? before.map((c) => /^(.*\S)\s+(\d{1,2}\/\d{1,2})$/.exec(c.text)).find((m) => m !== null) : null;
    const amountCell =
      amountEnd === null ? undefined : line.cells.slice(verbAt + 1).find((c) => Math.abs(c.xEnd - amountEnd) <= SLACK);
    // No amount, a quantity instead: securities moved in kind, read through
    // their own summary line (inKind below), never as cash.
    if (amountCell?.text === '-') continue;
    const amount = amountCell === undefined ? null : parseMoney(amountCell.text);
    const dateText = dateCell?.text ?? merged?.[2];
    if (dateText === undefined || amount === null) {
      throw new Error(`a "${line.cells[verbAt].text}" row (${at(line.cells[verbAt])}) has no date or no amount`);
    }
    const names = before.filter((c) => c !== dateCell).map((c) => (merged != null && c.text === merged[0] ? merged[1] : c.text));
    rows.push({ dateText, description: [...names, line.cells[verbAt].text], amount });
  }
  return rows.length === 0 ? null : { rows, total: null };
}

/**
 * Securities moved in kind: "Transferred From/To" rows whose Amount is "-",
 * each followed by a line naming the other account and "VALUE OF
 * TRANSACTION", then that value on a line of its own. One row per security at
 * that value, on either side (a section of its own on one, the activity table
 * on the other). Null when no such row is listed.
 */
function inKind(lines: TextLine[], direction: 'From' | 'To') {
  const verb = new RegExp(`^Transferred ${direction}$`, 'i');
  const rows: { dateText: string; description: string[]; amount: number }[] = [];
  lines.forEach((line, i) => {
    const verbAt = line.cells.findIndex((c) => verb.test(c.text));
    if (verbAt === -1 || line.cells[line.cells.length - 1].text !== '-') return;
    const before = line.cells.slice(0, verbAt);
    const dated = before.map((c) => /^(.*?)\s*(\d{1,2}\/\d{1,2})$/.exec(c.text)).find((m) => m !== null);
    const following = lines.slice(i + 1, i + 7);
    const next = following.findIndex((l) => l.cells.some((c) => ROW_DATE.test(c.text)));
    const block = next === -1 ? following : following.slice(0, next);
    const labelAt = block.findIndex((l) => /VALUE OF TRANSACTION$/i.test(l.cells[0]?.text ?? ''));
    const value = labelAt === -1 ? null : parseMoney(block[labelAt + 1]?.cells[0]?.text ?? '');
    if (dated == null || value === null) {
      throw new Error(`an in-kind "${line.cells[verbAt].text}" row (${at(line.cells[verbAt])}) prints no date or no value of transaction`);
    }
    const names = before.map((c) => (c.text === dated[0] ? dated[1] : c.text)).filter((t) => t !== '' && !/^\d+[A-Z\d]*$/.test(t));
    const other = block[labelAt].cells[0].text.replace(/\s*VALUE OF TRANSACTION$/i, '');
    rows.push({ dateText: dated[2], description: [...names, line.cells[verbAt].text, other, '(in kind)'], amount: value });
  });
  return rows.length === 0 ? null : { rows, total: null };
}

export const fidelityReport: StatementLayout = {
  id: 'fidelity-report',

  detect(lines) {
    const has = (pattern: RegExp) => lines.some((l) => pattern.test(l.text));
    return has(/fidelity/i) && has(/investment report/i) && has(/^Beginning Account Value/i);
  },

  parse(lines) {
    if (lines.some((l) => YEAR_END.test(l.text))) {
      throw new Error('a year-end report, one summary of the whole year; the monthly reports carry its months');
    }
    const period = lines.map((l) => PERIOD.exec(l.text)).find((m) => m !== null);
    const periodStart = period ? parseLongDate(period[1]) : null;
    const periodEnd = period ? parseLongDate(period[2]) : null;
    if (periodStart === null || periodEnd === null) throw new Error('no statement period');

    const statements: ParsedStatement[] = [];
    const accounts = byAccount(lines);
    for (const account of accounts) {
      const column = thisPeriodColumn(account.lines);
      if (column === null) continue; // pages with no account summary of their own
      const s = summary(account.lines, column, account.number);

      const rows: StatementRow[] = [];
      const sectionOf = new Map<StatementRow, string>();
      /** Rows of a heading of their own, which Additions and Subtractions do not count. */
      const ownHeading = new Set<StatementRow>();
      const checks: StatementCheck[] = [];
      /** Costs paid inside the account, counted with its change in value. */
      let kept = 0;
      for (const line of s.breakdown) {
        if (line.value === 0) continue;
        if (COSTS.test(line.name)) {
          kept += line.sign * Math.abs(line.value);
          continue;
        }
        const name = line.name.toLowerCase();
        const exchange = EXCHANGE.exec(line.name);
        const read =
          line.heading === true
            ? inKind(account.lines, line.sign === 1 ? 'From' : 'To')
            : (section(account.lines, line.name) ??
              (exchange === null ? null : transferRows(account.lines, exchange[1].toLowerCase() === 'in' ? 'From' : 'To')));
        if (read === null) {
          throw new Error(`account ${account.number} shows "${line.name}" this period, but no "${line.name}" section lists its rows`);
        }
        for (const r of read.rows) {
          const row: StatementRow = {
            date: rowDate(r.dateText, periodEnd),
            description: r.description.join(' '),
            amount: line.sign * Math.abs(r.amount),
          };
          rows.push(row);
          sectionOf.set(row, name);
          if (line.heading === true) ownHeading.add(row);
        }
        checks.push({ label: `${line.name} in the account summary`, printedCents: cents(line.value), rows: (r) => sectionOf.get(r) === name });
        if (read.total !== null) {
          checks.push({ label: `Total ${line.name}`, printedCents: cents(read.total), rows: (r) => sectionOf.get(r) === name });
        }
      }
      // Each heading less the costs under it, which are no rows.
      const costsUnder = (sign: 1 | -1) =>
        s.breakdown.filter((b) => b.sign === sign && COSTS.test(b.name)).reduce((total, b) => total + Math.abs(cents(b.value)), 0);
      checks.push(
        { label: 'additions in the account summary', printedCents: Math.abs(cents(s.additions)) - costsUnder(1), rows: (r) => r.amount > 0 && !ownHeading.has(r) },
        { label: 'subtractions in the account summary', printedCents: Math.abs(cents(s.subtractions)) - costsUnder(-1), rows: (r) => r.amount < 0 && !ownHeading.has(r) },
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
        marketChange: s.market + kept,
        rows,
        checks,
      });
    }
    if (statements.length === 0) throw new Error(noAccountRead(lines, accounts));
    return statements;
  },
};

/**
 * Why no account was read, in the report's own terms: whether any page names
 * an account, and the column headings above the first beginning value.
 */
function noAccountRead(lines: TextLine[], accounts: AccountLines[]): string {
  if (accounts.length === 0) return 'no page names an account ("Account #")';
  const begins = lines.findIndex((l) => /^Beginning Account Value/i.test(l.cells[0]?.text ?? ''));
  const above = begins > 0 ? lines[begins - 1] : null;
  const headings = above === null ? 'none' : above.cells.map((c) => `"${c.text}" ${at(c)}`).join(', ');
  const periods = lines
    .flatMap((l) => l.cells.filter((c) => c.text === 'This Period').map((c) => `page ${l.page} ${at(c)}`))
    .slice(0, 6);
  return `${accounts.length} account section(s), none with an account summary under a "This Period" column left of x ${SUMMARY_MAX_X}; "This Period" is printed at: ${periods.length > 0 ? periods.join(', ') : 'nowhere'}; the line above the first beginning value reads: ${headings}`;
}
