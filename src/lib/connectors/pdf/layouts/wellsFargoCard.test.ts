import { describe, expect, it } from 'vitest';
import type { TextLine } from '../lines';
import { noonUtc, reconcile, type ParsedStatement } from '../statement';
import { chaseCard } from './chaseCard';
import { wellsFargoCard } from './wellsFargoCard';
import { wellsFargoDeposit } from './wellsFargoDeposit';

/**
 * Every fixture here is INVENTED, in the shape `npm run pdf:layout` prints for
 * an OCR'd Wells Fargo card statement: the same headings and column positions,
 * with the jitter OCR adds (an amount a few points off its row, two dates in
 * one cell, a letter where a digit was), never a real name, merchant or figure.
 */
type Cell = [x: number, xEnd: number, text: string];

const line = (page: number, y: number, ...cells: Cell[]): TextLine => ({
  page,
  y,
  cells: cells.map(([x, xEnd, text]) => ({ x, xEnd, text })),
  text: cells.map((c) => c[2]).join(' '),
});

const parseOne = (lines: TextLine[]): ParsedStatement => {
  const all = wellsFargoCard.parse(lines);
  expect(all).toHaveLength(1);
  return all[0];
};

// Page one: summary and the table's first section; page two: the terms, no
// header; page three: the table continued, its totals and the year-to-date
// block. The pages arrive in printed order, as the grouped files hold them.
const statement = (): TextLine[] => [
  // The card's name, split over two baselines by OCR, beside the page's own marks.
  line(1, 747, [365, 460, 'REWARDS® CARD'], [475, 503, 'Mark Here']),
  line(1, 745, [255, 363, 'WELLS FARGO EXAMPLE']),
  line(1, 735, [379, 457, 'Account ending in 1234']),
  line(1, 724, [318, 457, 'Statement Period 09/03/2025 to 10/02/2025']),
  line(1, 715, [427, 457, 'Page 1 of 3']),
  line(1, 659, [312, 369, 'Minimum Payment'], [504, 525, '$25.00']),
  line(1, 649, [312, 352, 'New Balance'], [504, 525, '$524.34']),
  line(1, 575, [109, 177, 'Account Summary']),
  line(1, 563, [110, 163, 'Previous Balance'], [309, 326, '$250.00'], [346, 398, 'Total Credit Limit'], [507, 528, '$5,000']),
  line(1, 554, [109, 147, '— Payments'], [305, 326, '$250.00'], [360, 413, 'Cash Advance Limit'], [510, 528, '$1,000']),
  line(1, 545, [109, 158, '— Other Credits'], [308, 327, '$12.00'], [346, 411, 'Total Available Credit'], [507, 528, '$4,587']),
  line(1, 536, [110, 165, '+ Cash Advances'], [308, 327, '$0.00']),
  line(1, 526, [110, 216, '+ Purchases, Balance Transfers &'], [306, 327, '$532.84']),
  line(1, 518, [117, 162, 'Other Charges']),
  line(1, 510, [110, 162, '+ Fees Charged'], [309, 327, '$0.00']),
  line(1, 502, [109, 171, '+ Interest Charged'], [310, 327, '$3.50']),
  line(1, 493, [110, 157, '= New Balance'], [306, 327, '$524.34']),
  line(1, 463, [110, 182, 'Rewards balance as of:'], [315, 350, '10/02/2025'], [407, 418, '123']),
  line(1, 411, [110, 157, 'Transactions']),
  line(1, 396, [113, 126, 'Card'], [140, 176, 'Trans Post'], [194, 247, 'Reference Number'], [264, 298, 'Description'], [460, 481, 'Credits'], [502, 525, 'Charges']),
  line(1, 388, [113, 132, 'Ending'], [141, 153, 'Date'], [163, 176, 'Date']),
  line(1, 381, [113, 117, 'in']),
  line(1, 366, [110, 145, 'Payments']),
  line(1, 352, [141, 177, '09/15 09/15'], [193, 318, 'F0000000000000001 __ONLINE PAYMENT'], [337, 372, 'THANK YOU'], [466, 480, '250.00']),
  line(1, 344, [140, 249, 'TOTAL PAYMENTS FOR THIS PERIOD'], [462, 480, '$250.00']),
  line(1, 338, [110, 158, 'Other Credits']),
  // A refund, under Credits.
  line(1, 335, [109, 122, '1234'], [140, 154, '09/22'], [163, 177, '09/23'], [193, 255, 'F0000000000000005'], [264, 366, 'EXAMPLE SHOP SPRINGFIELD IL'], [466, 480, '12.00']),
  line(1, 333, [140, 262, 'TOTAL OTHER CREDITS FOR THIS PERIOD'], [462, 480, '$12.00']),
  line(1, 331, [110, 282, 'Purchases, Balance Transfers & Other Charges']),
  line(1, 316, [109, 122, '1234'], [140, 154, '09/04'], [163, 177, '09/05'], [193, 252, 'F0000000000000002'], [265, 366, 'CORNER CAFE SPRINGFIELD IL'], [515, 526, '8.50']),
  // The dates ran together, the amount drifted three points below its row.
  line(1, 310, [109, 122, '1234'], [140, 177, '09/1O 09/11'], [193, 252, 'F0000000000000003'], [265, 366, 'EXAMPLE GROCER SPRINGFIELD IL'], [511, 526, '$10O.00']),
  line(1, 303, [109, 122, '1234'], [140, 154, '09/20__'], [163, 177, '09/21'], [193, 366, 'F0000000000000004 = EXAMPLE SHOP SPRINGFIELD IL']),
  line(1, 300, [514, 526, '300.34']),
  line(1, 229, [190, 445, 'NOTICE: SEE REVERSE SIDE FOR IMPORTANT INFORMATION ABOUT YOUR ACCOUNT']),
  line(1, 225, [480, 508, 'Continued'], [520, 533, 'xxx)']),
  line(1, 192, [322, 366, 'Account Number'], [468, 526, '0000 0000 0000 1234']),
  line(1, 168, [322, 357, 'New Balance']),
  line(1, 166, [507, 526, '$524.34']),
  line(2, 532, [126, 192, 'Important Payments']),
  line(2, 373, [109, 169, 'Conforming Payments']),
  line(3, 733, [381, 459, 'Account ending in 1234']),
  line(3, 722, [320, 459, 'Statement Period 09/03/2025 to 10/02/2025']),
  line(3, 713, [429, 459, 'Page 3 of 3']),
  line(3, 677, [111, 251, 'Transactions (continued from previous page)']),
  line(3, 661, [114, 127, 'Card'], [142, 177, 'Trans Post'], [196, 249, 'Reference Number'], [266, 300, 'Description'], [462, 482, 'Credits'], [503, 527, 'Charges']),
  line(3, 653, [114, 133, 'Ending'], [143, 155, 'Date'], [165, 178, 'Date']),
  line(3, 618, [111, 124, '1234'], [142, 157, '09/30'], [165, 179, '10/01'], [195, 258, 'F0000000000000006'], [267, 368, 'EXAMPLE MARKET SPRINGFIELD IL'], [517, 528, '124.00']),
  line(3, 589, [142, 386, 'TOTAL PURCHASES, BALANCE TRANSFERS & OTHER CHARGES FOR THIS PERIOD'], [510, 528, '$532.84']),
  line(3, 575, [111, 160, 'Fees Charged']),
  line(3, 560, [142, 265, 'TOTAL FEES CHARGED FOR THIS PERIOD'], [513, 528, '$0.00']),
  line(3, 547, [111, 178, 'Interest Charged']),
  line(3, 533, [267, 375, 'INTEREST CHARGE ON PURCHASES'], [516, 528, '3.50']),
  line(3, 524, [267, 388, 'INTEREST CHARGE ON CASH ADVANCES'], [516, 528, '0.00']),
  line(3, 515, [142, 279, 'TOTAL INTEREST CHARGED FOR THIS PERIOD'], [513, 527, '$3.50']),
  line(3, 500, [295, 384, '2025 Totals Year-to-Date']),
  line(3, 482, [204, 295, 'TOTAL FEES CHARGED IN 2025'], [447, 462, '$0.00']),
  line(3, 475, [204, 309, 'TOTAL INTEREST CHARGED IN 2025'], [447, 462, '$9.75']),
  line(3, 469, [114, 214, 'Interest Charge Calculation']),
  line(3, 425, [275, 291, '(APR)'], [376, 395, 'Billing'], [412, 456, 'Interest Charge'], [476, 515, 'Balance as of']),
  line(3, 403, [261, 310, '24.99% variable'], [500, 528, '$1,234.56']),
];

describe('wellsFargoCard', () => {
  it('reads the period, the account and the balances, owed balances negative', () => {
    const s = parseOne(statement());
    expect([s.periodStart, s.periodEnd]).toEqual([noonUtc(2025, 9, 3), noonUtc(2025, 10, 2)]);
    expect([s.accountLast4, s.institution, s.accountType, s.cardName]).toEqual(['1234', 'Wells Fargo', 'CREDIT', 'WELLS FARGO EXAMPLE REWARDS CARD']);
    expect([s.openingBalance, s.closingBalance]).toEqual([-250, -524.34]);
  });

  it('reads every row by its post date and column, the reference dropped, OCR jitter absorbed', () => {
    expect(parseOne(statement()).rows).toEqual([
      { date: noonUtc(2025, 9, 15), description: 'ONLINE PAYMENT THANK YOU', amount: 250 },
      { date: noonUtc(2025, 9, 23), description: 'EXAMPLE SHOP SPRINGFIELD IL', amount: 12 },
      { date: noonUtc(2025, 9, 5), description: 'CORNER CAFE SPRINGFIELD IL', amount: -8.5 },
      { date: noonUtc(2025, 9, 11), description: 'EXAMPLE GROCER SPRINGFIELD IL', amount: -100 },
      { date: noonUtc(2025, 9, 21), description: 'EXAMPLE SHOP SPRINGFIELD IL', amount: -300.34 },
      { date: noonUtc(2025, 10, 1), description: 'EXAMPLE MARKET SPRINGFIELD IL', amount: -124 },
      { date: noonUtc(2025, 10, 2), description: 'INTEREST CHARGE ON PURCHASES', amount: -3.5 },
    ]);
  });

  it('adds up to its balances, to every summary line and to every section total', () => {
    const s = parseOne(statement());
    expect(s.checks.map((c) => c.label)).toEqual([
      'payments in the account summary',
      'payments total for this period',
      'other credits in the account summary',
      'other credits total for this period',
      'cash advances in the account summary',
      'purchases, balance transfers and other charges in the account summary',
      'purchases, balance transfers and other charges total for this period',
      'fees charged in the account summary',
      'fees charged total for this period',
      'interest charged in the account summary',
      'interest charged total for this period',
    ]);
    expect(reconcile(s)).toEqual([]);
  });

  it('a dropped row fails the balance and its section, twice over', () => {
    const lines = statement().filter((l) => !l.text.includes('EXAMPLE MARKET'));
    expect(reconcile(parseOne(lines))).toEqual([
      'rows add up to -150.34 but the balance moved -274.34',
      'purchases, balance transfers and other charges in the account summary: rows add up to 408.84, the statement prints 532.84',
      'purchases, balance transfers and other charges total for this period: rows add up to 408.84, the statement prints 532.84',
    ]);
  });

  // OCR sets the amount column as a block of its own, so every amount of a
  // section can sit a whole row below its row, the last on a line alone.
  it('pairs a section\x27s amounts to its rows in order when the whole column drifted a row', () => {
    const base = statement();
    const purchases = base.filter((l) => l.page === 1 && [316, 310, 303, 300].includes(l.y));
    const amounts = purchases.flatMap((l) => l.cells.filter((c) => c.x > 500));
    const rows = purchases.filter((l) => l.cells.some((c) => c.x < 200));
    const drifted = base.flatMap((l) => {
      if (!purchases.includes(l)) return [l];
      if (!rows.includes(l)) return [];
      const k = rows.indexOf(l);
      const kept = l.cells.filter((c) => c.x <= 500);
      const own = { page: 1, y: l.y, cells: kept, text: kept.map((c) => c.text).join(' ') };
      const below = rows[k + 1]?.y ?? l.y - 7;
      const amount = { page: 1, y: below - 0.5, cells: [amounts[k]], text: amounts[k].text };
      return [own, amount];
    });
    expect(parseOne(drifted).rows).toEqual(parseOne(base).rows);
    expect(reconcile(parseOne(drifted))).toEqual([]);
  });

  it('reads a header whose Credits and Charges labels sit on a line of their own', () => {
    const lines = statement().flatMap((l) =>
      l.page === 1 && l.y === 396
        ? [line(1, 396, ...l.cells.filter((c) => c.x < 400).map((c) => [c.x, c.xEnd, c.text] as Cell)), line(1, 394, [460, 481, 'Credits'], [502, 525, 'Charges'])]
        : [l],
    );
    expect(parseOne(lines).rows).toEqual(parseOne(statement()).rows);
  });

  it('reads a post date with one unreadable digit when the period leaves one digit possible', () => {
    // "?9/21" can only be 09/21 inside 09/03..10/02.
    const resolved = statement().map((l) => (l.y === 303 && l.page === 1 ? line(1, 303, [109, 122, '1234'], [140, 154, '09/20'], [163, 177, 'T9/21'], [193, 366, 'F0000000000000004 = EXAMPLE SHOP SPRINGFIELD IL']) : l));
    expect(parseOne(resolved).rows).toEqual(parseOne(statement()).rows);
    // "19/21" is no date; of every one-digit change only 09/21 falls inside the period.
    const wrongDigit = statement().map((l) => (l.y === 303 && l.page === 1 ? line(1, 303, [109, 122, '1234'], [140, 154, '09/20'], [163, 177, '19/21'], [193, 366, 'F0000000000000004 = EXAMPLE SHOP SPRINGFIELD IL']) : l));
    expect(parseOne(wrongDigit).rows).toEqual(parseOne(statement()).rows);
  });

  it('dates a row by its trans date when its post date is beyond reading', () => {
    // "09/2?" could be the 20th to the 29th: not resolved, so the trans date stands in.
    const ambiguous = statement().map((l) => (l.y === 303 && l.page === 1 ? line(1, 303, [109, 122, '1234'], [140, 154, '09/20'], [163, 177, '09/2T'], [193, 366, 'F0000000000000004 = EXAMPLE SHOP SPRINGFIELD IL']) : l));
    const s = parseOne(ambiguous);
    expect(s.rows[4]).toEqual({ date: noonUtc(2025, 9, 20), description: 'EXAMPLE SHOP SPRINGFIELD IL', amount: -300.34 });
    expect(reconcile(s)).toEqual([]);
  });

  it('reads the one date a row carries on an older statement as its date', () => {
    const lines = statement().map((l) =>
      l.y === 303 && l.page === 1 ? line(1, 303, [109, 122, '1234'], [140, 154, '09/21'], [193, 366, 'F0000000000000004 = EXAMPLE SHOP SPRINGFIELD IL']) : l,
    );
    expect(parseOne(lines).rows).toEqual(parseOne(statement()).rows);
  });

  it('reads a header whose labels carry scan noise, Charges on a line of its own', () => {
    const lines = statement().flatMap((l) =>
      l.page === 3 && l.y === 661
        ? [line(3, 661, ...l.cells.filter((c) => c.x < 500).map((c) => [c.x, c.xEnd, c.text] as Cell)), line(3, 659, [503, 527, 'Charges|'])]
        : [l],
    );
    expect(parseOne(lines).rows).toEqual(parseOne(statement()).rows);
  });

  it('reads a trans date whose slash was lost as the garbled date it is, keeping the post date', () => {
    const lines = statement().map((l) => (l.y === 303 && l.page === 1 ? line(1, 303, [109, 122, '1234'], [140, 177, '0920 09/21'], [193, 366, 'F0000000000000004 = EXAMPLE SHOP SPRINGFIELD IL']) : l));
    expect(parseOne(lines).rows).toEqual(parseOne(statement()).rows);
  });

  it('never reads money printed after the table as a row', () => {
    // The interest charge calculation's balance sits under the Charges column.
    const s = parseOne(statement());
    expect(s.rows.some((r) => Math.abs(r.amount) === 1234.56)).toBe(false);
  });

  it('refuses a row posted outside the statement period: a misread date, not a guess', () => {
    const lines = statement().map((l) => (l.y === 316 && l.page === 1 ? line(1, 316, [109, 122, '1234'], [140, 154, '09/04'], [163, 177, '11/05'], [193, 252, 'F0000000000000002'], [265, 366, 'CORNER CAFE SPRINGFIELD IL'], [515, 526, '8.50']) : l));
    expect(() => parseOne(lines)).toThrow('the 11/05 row on page 1 is posted outside the statement period');
  });

  it('drops a row with no date it can read, so the statement no longer adds up', () => {
    const lines = statement().map((l) => (l.y === 316 && l.page === 1 ? line(1, 316, [109, 122, '1234'], [140, 154, 'X#A#'], [163, 177, 'X#A#'], [193, 252, 'F0000000000000002'], [265, 366, 'CORNER CAFE SPRINGFIELD IL'], [515, 526, '8.50']) : l));
    expect(reconcile(parseOne(lines)).length).toBeGreaterThan(0);
  });

  it('says how many rows and amounts a section without an amount for every row holds, never what they said', () => {
    const lines = statement().map((l) => (l.y === 316 && l.page === 1 ? line(1, 316, [109, 122, '1234'], [140, 154, '09/04'], [163, 177, '09/05'], [193, 252, 'F0000000000000002'], [265, 366, 'CORNER CAFE SPRINGFIELD IL'], [400, 420, 'Q']) : l));
    expect(() => parseOne(lines)).toThrow(
      'the 09/05 row on page 1 has no amount under Credits or Charges (the columns end at x 481 and 525; its section holds 3 rows and 2 amounts on the page)',
    );
  });

  it('refuses pages that disagree on the period', () => {
    const lines = statement().map((l) => (l.page === 3 && l.y === 722 ? line(3, 722, [320, 459, 'Statement Period 10/03/2025 to 11/02/2025']) : l));
    expect(() => parseOne(lines)).toThrow(/pages disagree on the statement period/);
  });

  it('recognises only its own statements', () => {
    expect(wellsFargoCard.detect(statement())).toBe(true);
    expect(wellsFargoDeposit.detect(statement())).toBe(false);
    expect(chaseCard.detect(statement())).toBe(false);
  });
});
