import { describe, expect, it } from 'vitest';
import type { TextLine } from '../lines';
import { noonUtc, reconcile, type ParsedStatement, type StatementLayout } from '../statement';
import { chaseCard } from './chaseCard';
import { wellsFargoDeposit } from './wellsFargoDeposit';

/**
 * Every fixture here is INVENTED, in the shape `npm run pdf:layout` prints for
 * the real layouts: the same headings, column positions and wrapping, never a
 * real name, merchant or figure.
 */
type Cell = [x: number, xEnd: number, text: string];

/** A bank or card statement file holds exactly one account. */
const parseOne = (layout: StatementLayout, lines: TextLine[]): ParsedStatement => {
  const all = layout.parse(lines);
  expect(all).toHaveLength(1);
  return all[0];
};
const line = (page: number, y: number, ...cells: Cell[]): TextLine => ({
  page,
  y,
  cells: cells.map(([x, xEnd, text]) => ({ x, xEnd, text })),
  text: cells.map((c) => c[2]).join(' '),
});

// The older Wells Fargo layout: the period printed whole on page one.
const wellsFargo2019 = (): TextLine[] => [
  line(1, 745, [40, 318, 'Wells Fargo Everyday Checking']),
  line(1, 730, [40, 166, 'Account number: 0000001234'], [177, 343, 'n December 8, 2018 - January 9, 2019'], [353, 410, 'n Page 1 of 3']),
  line(1, 606, [40, 129, 'JANE Q DOE']),
  line(1, 284, [40, 128, 'Activity summary']),
  line(1, 273, [65, 154, 'Beginning balance on 12/8'], [268, 294, '$500.00'], [378, 451, 'JANE Q DOE']),
  line(1, 259, [65, 124, 'Deposits/Additions'], [272, 294, '1,000.00']),
  line(1, 247, [65, 146, 'Withdrawals/Subtractions'], [267, 295, '- 250.00']),
  line(1, 233, [65, 145, 'Ending balance on 1/9'], [266, 292, '$1,250.00']),
  line(2, 749, [40, 165, 'Account number: 0000001234'], [353, 409, 'n Page 2 of 3']),
  line(2, 670, [40, 138, 'Transaction history']),
  line(2, 643, [127, 147, 'Check'], [407, 436, 'Deposits/'], [463, 503, 'Withdrawals/'], [530, 569, 'Ending daily']),
  line(2, 633, [65, 80, 'Date'], [121, 187, 'Number Description'], [406, 435, 'Additions'], [466, 505, 'Subtractions'], [545, 569, 'balance']),
  line(2, 623, [65, 83, '12/14'], [152, 352, 'Online Transfer From Example Savings Ref'], [414, 436, '1,000.00']),
  line(2, 614, [152, 230, '#IB0000 on 12/14/18']),
  line(2, 605, [65, 83, '12/14'], [152, 360, 'ATM Withdrawal authorized on 12/14 Example Branch'], [483, 505, '200.00'], [548, 570, '1,300.00']),
  line(2, 595, [152, 303, 'Springfield IL 0000001 ATM ID 0000A Card 1234']),
  line(2, 586, [65, 79, '1/04'], [152, 363, 'Purchase authorized on 1/03 Corner Cafe'], [487, 505, '50.00'], [548, 570, '1,250.00']),
  line(2, 576, [152, 253, 'S000000000000000 Card 1234']),
  line(2, 565, [65, 145, 'Ending balance on 1/9'], [546, 568, '1,250.00']),
  line(2, 552, [65, 86, 'Totals'], [408, 435, '$1,000.00'], [477, 503, '$250.00']),
  line(2, 401, [73, 155, '· Minimum daily balance'], [418, 450, '$1,000.00'], [520, 560, '$500.00']),
];

// The newer layout: only the statement date, the summary on page two, no
// ending-balance line in the table.
const wellsFargo2026 = (statementDate = 'October 9, 2026', begin = '9/11', end = '10/9'): TextLine[] => [
  line(1, 751, [36, 314, 'Wells Fargo Everyday Checking']),
  line(1, 738, [36, 117, statementDate], [133, 179, 'Page 1 of 5']),
  line(2, 758, [36, 117, statementDate], [134, 180, 'Page 2 of 5']),
  line(2, 689, [356, 545, 'Account number: 0000005678 (primary account)']),
  line(2, 686, [36, 209, 'Statement period activity summary']),
  line(2, 674, [65, 158, `Beginning balance on ${begin}`], [290, 326, '$10,000.00']),
  line(2, 663, [65, 129, 'Deposits/Additions'], [299, 327, '2,500.00']),
  line(2, 650, [65, 151, 'Withdrawals/Subtractions'], [294, 328, '- 1,100.00']),
  line(2, 635, [65, 152, `Ending balance on ${end}`], [289, 328, '$11,400.00']),
  line(2, 548, [36, 131, 'Transaction history']),
  line(2, 527, [124, 143, 'Check'], [404, 434, 'Deposits/'], [458, 502, 'Withdrawals/'], [525, 565, 'Ending daily']),
  line(2, 518, [63, 78, 'Date'], [117, 187, 'Number Description'], [404, 434, 'Additions'], [462, 503, 'Subtractions'], [540, 566, 'balance']),
  line(2, 508, [62, 81, '9/12'], [150, 345, 'Online Transfer Ref #IB0000 to Example Savings'], [485, 503, '100.00'], [533, 565, '9,900.00']),
  line(2, 499, [150, 288, 'Card 1234 on 09/12/26']),
  line(2, 490, [62, 81, '10/01'], [150, 333, 'Zelle From Tess Example on 10/01 Ref # 0000'], [406, 434, '2,500.00']),
  line(2, 481, [62, 81, '10/01'], [150, 350, 'Example Utility Payment 000000 First Name Last'], [480, 502, '1,000.00'], [533, 565, '11,400.00']),
  line(2, 472, [150, 170, 'Name']),
  line(2, 312, [62, 83, 'Totals'], [400, 435, '$2,500.00'], [468, 503, '$1,100.00']),
  line(5, 686, [36, 212, 'Account Balance Calculation Worksheet'], [310, 346, 'Number'], [513, 549, 'Amount']),
];

describe('wellsFargoDeposit', () => {
  it('reads the older layout: period, account, balances and rows, wrapped lines joined', () => {
    const s = parseOne(wellsFargoDeposit, wellsFargo2019());
    expect([s.periodStart, s.periodEnd]).toEqual([noonUtc(2018, 12, 8), noonUtc(2019, 1, 9)]);
    expect([s.accountLast4, s.accountType, s.openingBalance, s.closingBalance]).toEqual(['1234', 'DEPOSITORY', 500, 1250]);
    expect(s.rows).toEqual([
      { date: noonUtc(2018, 12, 14), description: 'Online Transfer From Example Savings Ref #IB0000 on 12/14/18', amount: 1000, payee: 'Online Transfer From Example Savings' },
      { date: noonUtc(2018, 12, 14), description: 'ATM Withdrawal authorized on 12/14 Example Branch Springfield IL 0000001 ATM ID 0000A Card 1234', amount: -200, payee: 'ATM Withdrawal' },
      { date: noonUtc(2019, 1, 4), description: 'Purchase authorized on 1/03 Corner Cafe S000000000000000 Card 1234', amount: -50, payee: 'Corner Cafe' },
    ]);
    expect(reconcile(s)).toEqual([]);
  });

  it('reads the newer layout, taking the period from the statement date and the summary', () => {
    const s = parseOne(wellsFargoDeposit, wellsFargo2026());
    expect([s.periodStart, s.periodEnd]).toEqual([noonUtc(2026, 9, 11), noonUtc(2026, 10, 9)]);
    expect(s.accountLast4).toBe('5678');
    expect(s.rows.map((r) => [r.amount, r.description])).toEqual([
      [-100, 'Online Transfer Ref #IB0000 to Example Savings Card 1234 on 09/12/26'],
      [2500, 'Zelle From Tess Example on 10/01 Ref # 0000'],
      [-1000, 'Example Utility Payment 000000 First Name Last Name'],
    ]);
    expect(reconcile(s)).toEqual([]);
  });

  // Some older statements print only the date, set so close to the page
  // marker that the two read as one cell.
  it('reads a statement date that shares its cell with the page marker', () => {
    const lines = wellsFargo2026().map((l) =>
      l.page === 1 && l.y === 738 ? line(1, 738, [36, 157, 'October 9, 2026 n Page 1 of 5']) : l,
    );
    const s = parseOne(wellsFargoDeposit, lines.filter((l) => !(l.page === 2 && l.y === 758)));
    expect([s.periodStart, s.periodEnd]).toEqual([noonUtc(2026, 9, 11), noonUtc(2026, 10, 9)]);
  });

  it('never takes a date from the middle of a sentence', () => {
    const lines = wellsFargo2026()
      .filter((l) => !(l.y === 738 || l.y === 758))
      .concat(line(3, 623, [36, 529, 'We are letting you know that as of October 1, 2026, the posting order changes']));
    expect(() => parseOne(wellsFargoDeposit, lines)).toThrow(/no statement period or statement date/);
  });

  it('steps the start back a year when a statement-date-only period crosses New Year', () => {
    const s = parseOne(wellsFargoDeposit, wellsFargo2026('January 9, 2027', '12/8', '1/9').filter((l) => !/^(9\/12|10\/01)$/.test(l.cells[0].text)));
    expect([s.periodStart, s.periodEnd]).toEqual([noonUtc(2026, 12, 8), noonUtc(2027, 1, 9)]);
  });

  // The whole point of the column checks: a withdrawal read as a deposit
  // still sums somewhere, but not to the balances printed beside it.
  it('a row read into the wrong column fails the daily balance and the totals', () => {
    const lines = wellsFargo2026().map((l) =>
      l.cells[0].text === '9/12'
        ? line(2, l.y, [62, 81, '9/12'], [150, 345, 'Online Transfer'], [414, 434, '100.00'], [533, 565, '9,900.00'])
        : l,
    );
    expect(reconcile(parseOne(wellsFargoDeposit, lines)).length).toBeGreaterThan(0);
  });

  it('refuses an amount that sits under no column', () => {
    const lines = wellsFargo2026().map((l) =>
      l.cells[0].text === '9/12' ? line(2, l.y, [62, 81, '9/12'], [150, 345, 'Online Transfer'], [300, 320, '100.00']) : l,
    );
    expect(() => parseOne(wellsFargoDeposit, lines)).toThrow(/sits under no column/);
  });

  it('recognises only its own statements', () => {
    expect(wellsFargoDeposit.detect(wellsFargo2019())).toBe(true);
    expect(wellsFargoDeposit.detect(wellsFargo2026())).toBe(true);
    expect(wellsFargoDeposit.detect(chase())).toBe(false);
  });
});

// A Chase card statement: the summary on page one, the activity over two
// pages, with an airline row, an exchange-rate row and a doubled bold heading.
function chase(): TextLine[] {
  return [
    line(1, 989, [189, 268, 'www.chase.com/cardhelp']),
    line(1, 947, [162, 208, 'New Balance']),
    line(1, 932, [162, 212, '$625.50']),
    line(1, 609, [18, 163, 'AACCCCOOUUNNTT SSUUMMMMAARRYY']),
    line(1, 595, [18, 176, 'Account Number: XXXX XXXX XXXX 1234']),
    line(1, 581, [18, 78, 'Previous Balance'], [229, 248, '$1,000.00']),
    line(1, 569, [18, 78, 'Payment, Credits'], [211, 248, '-$1,000.00']),
    line(1, 558, [18, 55, 'Purchases'], [209, 248, '+$600.00']),
    line(1, 546, [18, 72, 'Cash Advances'], [229, 248, '$0.00']),
    line(1, 534, [18, 81, 'Balance Transfers`'], [229, 248, '$0.00']),
    line(1, 522, [18, 67, 'Fees Charged'], [220, 248, '+$25.50']),
    line(1, 510, [18, 76, 'Interest Charged'], [229, 248, '$0.00']),
    line(1, 496, [18, 67, 'New Balance'], [220, 249, '$625.50']),
    line(1, 484, [18, 94, 'Opening/Closing Date'], [181, 248, '12/03/24 - 01/02/25']),
    line(1, 181, [270, 335, 'New Balance:'], [470, 506, '$625.50']),
    line(3, 848, [26, 163, 'AACCCCOOUUNNTT AACCTTIIVVIITTYY']),
    line(3, 831, [37, 62, 'Date of']),
    line(3, 821, [29, 69, 'Transaction']),
    line(3, 819, [182, 332, 'Merchant Name or Transaction Description'], [452, 485, '$ Amount']),
    line(3, 806, [26, 175, 'PAYMENTS AND OTHER CREDITS']),
    line(3, 792, [27, 46, '12/28'], [112, 207, 'Payment Thank You-Mobile'], [459, 486, '-1,000.00']),
    line(3, 759, [26, 76, 'PURCHASE']),
    line(3, 746, [27, 46, '12/05'], [112, 267, 'CORNER CAFE SPRINGFIELD IL'], [462, 486, '100.00']),
    line(3, 733, [27, 46, '12/20'], [112, 146, 'EXAMPLE'], [156, 271, '0000000000000 EXAMPLECITY XX'], [462, 486, '300.00']),
    line(3, 724, [87, 129, '000000 1 X'], [174, 188, 'AAA'], [203, 218, 'BBB']),
    line(3, 700, [27, 46, '12/30'], [112, 269, 'EXAMPLE SHOP LONDON'], [462, 486, '150.00']),
    line(3, 690, [115, 217, '12/30 POUND STERLING']),
    line(3, 680, [126, 258, '120.00 X 1.250000000 (EXCHG RATE)']),
    line(3, 21, [18, 96, 'JANE Q DOE'], [248, 288, 'Page 3 of 4'], [407, 463, 'Statement Date:'], [474, 504, '01/02/25']),
    line(4, 934, [29, 265, 'ACCOUNT ACTIVITY (CONTINUED)']),
    line(4, 907, [185, 335, 'Merchant Name or Transaction Description'], [455, 488, '$ Amount']),
    line(4, 880, [30, 49, '01/01'], [114, 249, 'EXAMPLE GROCER'], [469, 489, '50.00']),
    line(4, 461, [29, 101, 'FEES CHARGED']),
    line(4, 448, [30, 49, '01/02'], [114, 217, 'ANNUAL MEMBERSHIP FEE'], [469, 489, '25.50']),
    line(4, 438, [141, 259, 'TOTAL FEES FOR THIS PERIOD'], [465, 489, '$25.50']),
    line(4, 405, [225, 320, '2025 Totals Year-to-Date']),
    line(4, 392, [169, 261, 'Total fees charged in 2025'], [345, 369, '$25.50']),
    line(5, 823, [26, 76, 'PURCHASES']),
    line(5, 812, [35, 71, 'Purchases'], [192, 237, '21.49%(v)(d)']),
  ];
}

describe('chaseCard', () => {
  it('reads the period, the account and the balances, owed balances negative', () => {
    const s = parseOne(chaseCard, chase());
    expect([s.periodStart, s.periodEnd]).toEqual([noonUtc(2024, 12, 3), noonUtc(2025, 1, 2)]);
    expect([s.accountLast4, s.institution, s.accountType]).toEqual(['1234', 'Chase', 'CREDIT']);
    expect([s.openingBalance, s.closingBalance]).toEqual([-1000, -625.5]);
  });

  it('reads every dated row across pages, in the app signs, skipping detail lines', () => {
    expect(parseOne(chaseCard, chase()).rows).toEqual([
      { date: noonUtc(2024, 12, 28), description: 'Payment Thank You-Mobile', amount: 1000 },
      { date: noonUtc(2024, 12, 5), description: 'CORNER CAFE SPRINGFIELD IL', amount: -100 },
      { date: noonUtc(2024, 12, 20), description: 'EXAMPLE 0000000000000 EXAMPLECITY XX', amount: -300 },
      { date: noonUtc(2024, 12, 30), description: 'EXAMPLE SHOP LONDON', amount: -150 },
      { date: noonUtc(2025, 1, 1), description: 'EXAMPLE GROCER', amount: -50 },
      { date: noonUtc(2025, 1, 2), description: 'ANNUAL MEMBERSHIP FEE', amount: -25.5 },
    ]);
  });

  it('adds up to its balances and to every section of the summary', () => {
    expect(reconcile(parseOne(chaseCard, chase()))).toEqual([]);
  });

  it('a dropped row fails the balance and its section', () => {
    const lines = chase().filter((l) => l.cells[0].text !== '01/01');
    expect(reconcile(parseOne(chaseCard, lines))).toEqual([
      'rows add up to 424.50 but the balance moved 374.50',
      'purchases in the account summary: rows add up to 550.00, the statement prints 600.00',
    ]);
  });

  it('reads a row whose long description ran into its amount, dated before the period opens', () => {
    const lines = chase().map((l) =>
      l.cells[0].text === '01/01'
        ? line(4, l.y, [30, 49, '11/28'], [114, 489, 'EXAMPLE VERY LONG MERCHANT NAME REACHING THE COLUMN 50.00'])
        : l,
    );
    const s = parseOne(chaseCard, lines);
    expect(s.rows.find((r) => r.amount === -50)).toEqual({
      date: noonUtc(2024, 11, 28),
      description: 'EXAMPLE VERY LONG MERCHANT NAME REACHING THE COLUMN',
      amount: -50,
    });
    expect(reconcile(s)).toEqual([]);
  });

  it('says where a row without an amount ended, never what it said', () => {
    const lines = chase().map((l) => (l.cells[0].text === '01/01' ? line(4, l.y, [30, 49, '01/01'], [114, 249, 'EXAMPLE GROCER'], [300, 320, 'X']) : l));
    expect(() => parseOne(chaseCard, lines)).toThrow(
      'the 01/01 row has no amount in the amount column (its text ends at x 49, 249, 320; the column ends at x 488; its last piece reads "X")',
    );
  });

  it('recognises only its own statements', () => {
    expect(chaseCard.detect(chase())).toBe(true);
    expect(chaseCard.detect(wellsFargo2019())).toBe(false);
  });
});
