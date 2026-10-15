import { describe, expect, it } from 'vitest';
import type { TextLine } from '../lines';
import { noonUtc, reconcile } from '../statement';
import { fidelityReport } from './fidelityReport';

/**
 * An INVENTED Investment Report in the shape `npm run pdf:layout` prints for
 * the real one: a portfolio overview, then each account under its own
 * "Account #" header, its summary on the left half of the page, and money-flow
 * sections among the activity. No real name, number or figure.
 */
type Cell = [x: number, xEnd: number, text: string];
const line = (page: number, y: number, ...cells: Cell[]): TextLine => ({
  page,
  y,
  cells: cells.map(([x, xEnd, text]) => ({ x, xEnd, text })),
  text: cells.map((c) => c[2]).join(' '),
});

const header = (page: number, account: string): TextLine[] => [
  line(page, 556, [644, 742, 'INVESTMENT REPORT']),
  line(page, 546, [568, 739, 'September 1, 2026 - September 30, 2026']),
  line(page, 499, [646, 741, `Account # ${account}`]),
  line(page, 489, [564, 741, 'JANE DOE - INDIVIDUAL - TOD']),
];

const report = (exchangesIn = '-'): TextLine[] => [
  // The portfolio overview, before any account: never read as an account.
  line(1, 556, [644, 742, 'INVESTMENT REPORT']),
  line(1, 546, [568, 739, 'September 1, 2026 - September 30, 2026']),
  line(1, 419, [409, 519, 'Beginning Portfolio Value'], [602, 652, '$120,000.00'], [692, 742, '$108,000.00']),
  line(1, 206, [49, 75, 'Online'], [292, 380, 'Fidelity.com/example']),

  // A brokerage account: deposits this period, and a market loss.
  ...header(4, 'X00-000001'),
  line(4, 491, [49, 173, 'Account Summary']),
  line(4, 393, [255, 299, 'This Period'], [335, 383, 'Year-to-Date']),
  line(4, 379, [49, 158, 'Beginning Account Value'], [247, 297, '$100,000.00'], [331, 381, '$90,000.00']),
  line(4, 375, [430, 530, '40% Domestic Stock']),
  line(4, 365, [49, 91, 'Additions'], [262, 297, exchangesIn === '-' ? '2,500.00' : '2,537.21'], [341, 382, '12,508.43']),
  line(4, 351, [58, 93, 'Deposits'], [262, 297, '2,500.00'], [342, 382, '12,500.00']),
  line(4, 337, [58, 113, 'Exchanges In'], [295, 298, exchangesIn], [364, 382, '8.43']),
  line(4, 323, [49, 104, 'Subtractions'], [295, 298, '-'], [351, 382, '-113.57']),
  line(4, 310, [58, 184, 'Transaction Account Fees'], [295, 298, '-'], [351, 382, '-113.57']),
  line(4, 295, [49, 175, 'Change in Investment Value *'], [259, 297, '-1,250.00'], [341, 382, '-1,144.86']),
  line(4, 279, [49, 145, 'Ending Account Value'], [247, 297, '$101,250.00'], [331, 381, '$101,250.00']),
  line(4, 266, [58, 141, 'Accrued Interest (AI)'], [280, 298, '0.00']),
  line(4, 250, [58, 177, 'Ending Account Value Incl. AI'], [247, 297, '$101,250.00']),
  line(4, 156, [606, 650, 'This Period'], [695, 743, 'Year-to-Date']),

  // A section that is NOT read: a trade, dated and with an amount.
  ...header(9, 'X00-000001'),
  line(9, 491, [49, 100, 'Activity']),
  line(9, 452, [49, 105, 'Security Name'], [210, 227, 'Date'], [713, 743, 'Amount']),
  line(9, 443, [49, 184, 'EXAMPLE INDEX FUND'], [210, 230, '09/05'], [310, 342, 'You Bought'], [715, 743, '-$463.19']),

  // The Deposits section, split across a page break.
  ...header(11, 'X00-000001'),
  line(11, 459, [49, 92, 'Deposits']),
  line(11, 442, [49, 67, 'Date'], [90, 129, 'Reference'], [310, 354, 'Description'], [713, 743, 'Amount']),
  line(11, 433, [49, 69, '09/03'], [310, 426, 'Eft Funds Received EF00000001'], [708, 743, '$1,612.34']),
  line(11, 423, [310, 412, 'Example Bank ******0001']),
  ...header(12, 'X00-000001'),
  line(12, 433, [49, 69, '09/17'], [310, 426, 'Eft Funds Received EF00000002'], [714, 743, '$887.66']),
  line(12, 423, [310, 412, 'Example Bank ******0001']),
  line(12, 412, [49, 104, 'Total Deposits'], [708, 743, '$2,500.00']),

  // A retirement account: no money in or out, only the market.
  ...header(17, '000-000002'),
  line(17, 491, [49, 173, 'Account Summary']),
  line(17, 393, [255, 299, 'This Period'], [335, 383, 'Year-to-Date']),
  line(17, 379, [49, 158, 'Beginning Account Value'], [252, 297, '$21,384.55'], [336, 381, '$18,000.00']),
  line(17, 365, [49, 175, 'Change in Investment Value *'], [272, 297, '-61.27'], [341, 382, '3,323.28']),
  line(17, 349, [49, 145, 'Ending Account Value'], [252, 297, '$21,323.28'], [336, 381, '$21,323.28']),
];

describe('fidelityReport', () => {
  it('reads one statement per account, with its value and the printed market change', () => {
    const [brokerage, ira] = fidelityReport.parse(report());
    expect([brokerage.accountLast4, brokerage.accountType, brokerage.institution]).toEqual(['0001', 'INVESTMENT', 'Fidelity']);
    expect([brokerage.periodStart, brokerage.periodEnd]).toEqual([noonUtc(2026, 9, 1), noonUtc(2026, 9, 30)]);
    expect([brokerage.openingBalance, brokerage.closingBalance, brokerage.marketChange]).toEqual([100000, 101250, -1250]);
    expect([ira.accountLast4, ira.openingBalance, ira.closingBalance, ira.marketChange, ira.rows]).toEqual(['0002', 21384.55, 21323.28, -61.27, []]);
  });

  // Trades, dividends and sweeps stay inside the account; only money crossing it is a row.
  it('reads the money-flow rows across a page break, and no trade', () => {
    expect(fidelityReport.parse(report())[0].rows).toEqual([
      { date: noonUtc(2026, 9, 3), description: 'Eft Funds Received EF00000001 Example Bank ******0001', amount: 1612.34 },
      { date: noonUtc(2026, 9, 17), description: 'Eft Funds Received EF00000002 Example Bank ******0001', amount: 887.66 },
    ]);
  });

  it('adds up: beginning + rows + market change = ending, and every section to its summary line', () => {
    for (const statement of fidelityReport.parse(report())) expect(reconcile(statement)).toEqual([]);
  });

  it('a dropped deposit fails the value and its section', () => {
    const lines = report().filter((l) => l.cells[0].text !== '09/17');
    expect(reconcile(fidelityReport.parse(lines)[0])).toEqual([
      'rows add up to 1612.34 but the value moved 2500.00 beyond the printed market change',
      'Deposits in the account summary: rows add up to 1612.34, the statement prints 2500.00',
      'Total Deposits: rows add up to 1612.34, the statement prints 2500.00',
      'additions in the account summary: rows add up to 1612.34, the statement prints 2500.00',
    ]);
  });

  // A report sets its summary wherever its page puts it; only the indent under a heading matters.
  it('reads a report set further left the same way', () => {
    const shifted = report().map((l) => ({ ...l, cells: l.cells.map((c) => ({ ...c, x: c.x - 18, xEnd: c.xEnd - 18 })) }));
    expect(fidelityReport.parse(shifted).map(({ checks, ...s }) => ({ ...s, checks: checks.length }))).toEqual(
      fidelityReport.parse(report()).map(({ checks, ...s }) => ({ ...s, checks: checks.length })),
    );
  });

  // Any line under Additions or Subtractions is read through the section of its own name.
  it('reads an exchange in through its own section', () => {
    const exchanges = [
      line(12, 380, [49, 118, 'Exchanges In']),
      line(12, 363, [49, 67, 'Date'], [90, 129, 'Reference'], [310, 354, 'Description'], [713, 743, 'Amount']),
      line(12, 354, [49, 69, '09/22'], [310, 420, 'Exchange In From X00-000003'], [722, 743, '$37.21']),
      line(12, 343, [49, 123, 'Total Exchanges In'], [722, 743, '$37.21']),
    ];
    // On the brokerage's own page, after its deposits.
    const lines = report('37.21').flatMap((l) =>
      l.page === 4 && l.cells[0].text === 'Ending Account Value'
        ? [{ ...l, cells: [l.cells[0], { ...l.cells[1], text: '$101,287.21' }, l.cells[2]] }]
        : l.cells[0].text === 'Total Deposits'
          ? [l, ...exchanges]
          : [l],
    );
    const [brokerage] = fidelityReport.parse(lines);
    expect(brokerage.rows.map((r) => [r.description, r.amount])).toContainEqual(['Exchange In From X00-000003', 37.21]);
    expect(reconcile(brokerage)).toEqual([]);
  });

  // Money moved that no section lists: refuse, naming it, rather than leave it out.
  it('refuses a statement moving money no section lists', () => {
    expect(() => fidelityReport.parse(report('37.21'))).toThrow(
      'account X00-000001 shows "Exchanges In" this period, but no "Exchanges In" section lists its rows',
    );
  });

  // A line whose figure cannot be placed must not vanish: Additions would then
  // look unexplained, and the reason would not say which line was missed.
  it('refuses a summary whose lines do not add up to their heading, naming what it read', () => {
    const lines = report().map((l) =>
      l.page === 4 && l.cells[0].text === 'Deposits' ? { ...l, cells: [{ ...l.cells[0], x: 49 }, ...l.cells.slice(1)] } : l,
    );
    expect(() => fidelityReport.parse(lines)).toThrow(
      'account X00-000001: the summary line "Deposits" (x 49-93) prints a figure this period but is not a line under Additions or Subtractions',
    );
    const unplaced = report().map((l) =>
      l.page === 4 && l.cells[0].text === 'Deposits' ? { ...l, cells: [l.cells[0], { ...l.cells[1], x: 200, xEnd: 230 }] } : l,
    );
    expect(() => fidelityReport.parse(unplaced)).toThrow(
      'account X00-000001: the lines read under Additions ("Exchanges In" 0.00) add up to 0.00, but Additions prints 2500.00; it reads: "Additions", "Deposits", "Exchanges In", "Subtractions", "Transaction Account Fees", "Change in Investment Value *", "Ending Account Value"',
    );
  });

  // An account holding only a balance prints no change line; the value check still has to hold.
  it('takes a missing change-in-value line as no change, which the value check then tests', () => {
    const lines = report().filter((l) => !(l.page === 17 && l.cells[0].text.startsWith('Change in')));
    const ira = fidelityReport.parse(lines)[1];
    expect(ira.marketChange).toBe(0);
    expect(reconcile(ira)).toEqual(['rows add up to 0.00 but the value moved -61.27 beyond the printed market change']);
  });

  it('refuses a change-in-value line with no figure, saying what it does read', () => {
    const lines = report().map((l) => (l.page === 17 && l.cells[0].text.startsWith('Change in') ? { ...l, cells: [l.cells[0]] } : l));
    expect(() => fidelityReport.parse(lines)).toThrow(
      'account 000-000002: the summary has no change in investment value in the This Period column (ending at x 299); it reads: "Change in Investment Value *", "Ending Account Value"',
    );
  });

  it('says why no account could be read', () => {
    const lines = report().map((l) => ({ ...l, cells: l.cells.map((c) => (c.text === 'This Period' ? { ...c, text: 'December' } : c)) }));
    expect(() => fidelityReport.parse(lines)).toThrow(
      '2 account section(s), none with an account summary under a "This Period" column left of x 400; "This Period" is printed at: nowhere; the line above the first beginning value reads: "December" x 255-299, "Year-to-Date" x 335-383',
    );
  });

  // A whole year in one summary overlaps every monthly report of that year.
  it('refuses the year-end report by name', () => {
    const lines = report().map((l) =>
      l.cells[0].text === 'INVESTMENT REPORT' ? { ...l, cells: [{ ...l.cells[0], text: '2026 YEAR-END INVESTMENT REPORT' }], text: '2026 YEAR-END INVESTMENT REPORT' } : l,
    );
    expect(() => fidelityReport.parse(lines)).toThrow('a year-end report, one summary of the whole year; the monthly reports carry its months');
  });

  it('recognises its own reports only', () => {
    expect(fidelityReport.detect(report())).toBe(true);
    expect(fidelityReport.detect(report().filter((l) => !/INVESTMENT REPORT/.test(l.text)))).toBe(false);
  });
});
