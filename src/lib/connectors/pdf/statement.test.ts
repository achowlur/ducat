import { describe, expect, it } from 'vitest';
import {
  noonUtc,
  parseFullDate,
  parseMoney,
  reconcile,
  rowDate,
  settleLatePostings,
  splitTrailingAmount,
  transactionDateNote,
  type ParsedStatement,
} from './statement';

describe('parseMoney', () => {
  it('reads the shapes statements print', () => {
    expect(parseMoney('$1,234.50')).toBe(1234.5);
    expect(parseMoney('12.00')).toBe(12);
    expect(parseMoney('-500.00')).toBe(-500);
    expect(parseMoney('500.00-')).toBe(-500);
    expect(parseMoney('(75.00)')).toBe(-75);
    expect(parseMoney('75.00 CR')).toBe(-75);
    expect(parseMoney('-$1,000.00')).toBe(-1000);
    expect(parseMoney('$-1,000.00')).toBe(-1000);
    expect(parseMoney('+$600.00')).toBe(600);
    expect(parseMoney('−45.00')).toBe(-45); // a typeset minus sign
    expect(parseMoney('.99')).toBe(0.99);
    expect(parseMoney('-.99')).toBe(-0.99);
  });

  it('refuses anything that is not money', () => {
    for (const raw of ['', '12', '1,23.00', '12.5', 'CARD 1234', '01/03']) {
      expect(parseMoney(raw)).toBeNull();
    }
  });
});

describe('statement dates', () => {
  it('reads a full date with a two- or four-digit year', () => {
    expect(parseFullDate('03/09/25')).toEqual(noonUtc(2025, 3, 9));
    expect(parseFullDate('1/5/2025')).toEqual(noonUtc(2025, 1, 5));
    expect(parseFullDate('02/30/25')).toBeNull();
  });

  // A December-to-January statement spans two years.
  it('gives a MM/DD row the latest year that does not put it after the period', () => {
    const end = noonUtc(2025, 1, 9);
    expect(rowDate('12/28', end)).toEqual(noonUtc(2024, 12, 28));
    expect(rowDate('01/03', end)).toEqual(noonUtc(2025, 1, 3));
  });

  // A card lists a late-posted row by its original transaction date: a
  // refund can sit months before the period it appears in.
  it('places a late-posted row months before the period, in the right year', () => {
    expect(rowDate('03/11', noonUtc(2026, 8, 9))).toEqual(noonUtc(2026, 3, 11));
    expect(rowDate('11/28', noonUtc(2025, 2, 9))).toEqual(noonUtc(2024, 11, 28));
  });

  it('refuses an impossible date rather than rolling it over', () => {
    expect(() => rowDate('02/30', noonUtc(2025, 3, 15))).toThrow(/not a real date/);
    expect(() => rowDate('13/01', noonUtc(2025, 3, 15))).toThrow(/not a real date/);
  });
});

describe('settleLatePostings', () => {
  const base = (rows: ParsedStatement['rows']): ParsedStatement => ({
    layout: 'test',
    institution: 'Example Bank',
    accountType: 'CREDIT',
    accountLast4: '1234',
    periodStart: noonUtc(2026, 8, 10),
    periodEnd: noonUtc(2026, 9, 9),
    openingBalance: 0,
    closingBalance: 0,
    rows,
    checks: [],
  });

  // The money moved in this period; a closed month should not reopen for it.
  it('moves a row posted months late to the opening day, keeping its own date', () => {
    const settled = settleLatePostings(base([{ date: noonUtc(2026, 3, 11), description: 'EXAMPLE DINER', amount: -12 }]));
    expect(settled.rows).toEqual([
      { date: noonUtc(2026, 8, 10), description: 'EXAMPLE DINER', amount: -12, transactionDate: noonUtc(2026, 3, 11) },
    ]);
    expect(transactionDateNote(noonUtc(2026, 3, 11))).toBe('(transaction date 03/11/2026)');
  });

  it('leaves an ordinary few-day posting lag on its own date', () => {
    const s = base([{ date: noonUtc(2026, 8, 5), description: 'EXAMPLE DINER', amount: -12 }]);
    expect(settleLatePostings(s)).toBe(s);
  });
});

describe('splitTrailingAmount', () => {
  const cell = (x: number, xEnd: number, text: string) => ({ x, xEnd, text });

  it('splits an amount a long description ran into', () => {
    expect(splitTrailingAmount([cell(27, 46, '01/10'), cell(112, 486, 'EXAMPLE LONG MERCHANT NAME 50.00')], 486, 15)).toEqual([
      cell(27, 46, '01/10'),
      cell(112, 486, 'EXAMPLE LONG MERCHANT NAME'),
      cell(486, 486, '50.00'),
    ]);
  });

  it('leaves a line alone unless its last cell ends at the column with money', () => {
    const apart = [cell(27, 46, '01/10'), cell(112, 260, 'EXAMPLE'), cell(466, 486, '50.00')];
    expect(splitTrailingAmount(apart, 486, 15)).toBe(apart);
    const short = [cell(27, 46, '01/10'), cell(112, 260, 'EXAMPLE 50.00')];
    expect(splitTrailingAmount(short, 486, 15)).toBe(short);
    const wordy = [cell(27, 46, '01/10'), cell(112, 486, 'EXAMPLE STORE')];
    expect(splitTrailingAmount(wordy, 486, 15)).toBe(wordy);
  });
});

describe('reconcile', () => {
  // An invented card statement in the app's signs: the balance owed is negative.
  const statement = (overrides: Partial<ParsedStatement> = {}): ParsedStatement => ({
    layout: 'test',
    institution: 'Example Bank',
    accountType: 'CREDIT',
    accountLast4: '1234',
    periodStart: noonUtc(2024, 12, 3),
    periodEnd: noonUtc(2025, 1, 9),
    openingBalance: -1000,
    closingBalance: -670,
    rows: [
      { date: noonUtc(2024, 12, 28), description: 'PAYMENT THANK YOU', amount: 500 },
      { date: noonUtc(2024, 12, 5), description: 'CORNER CAFE', amount: -20 },
      { date: noonUtc(2025, 1, 4), description: 'EXAMPLE GROCER', amount: -150 },
    ],
    checks: [{ label: 'Purchases', printedCents: 17000, rows: (r) => r.amount < 0 }],
    ...overrides,
  });

  it('passes a statement whose rows explain the balance and every printed total', () => {
    expect(reconcile(statement())).toEqual([]);
  });

  it('refuses a statement missing a row', () => {
    const s = statement();
    expect(reconcile({ ...s, rows: s.rows.slice(1) })).toEqual([
      'rows add up to -170.00 but the balance moved 330.00',
    ]);
  });

  it('refuses a printed total the rows do not reach', () => {
    expect(
      reconcile(statement({ checks: [{ label: 'Purchases', printedCents: 18000, rows: (r) => r.amount < 0 }] })),
    ).toEqual(['Purchases: rows add up to 170.00, the statement prints 180.00']);
  });

  // Floating point would drift over hundreds of rows; cents do not.
  it('adds in cents', () => {
    const rows = Array.from({ length: 300 }, () => ({ date: noonUtc(2025, 1, 2), description: 'X', amount: -0.1 }));
    expect(reconcile(statement({ openingBalance: 0, closingBalance: -30, rows, checks: [] }))).toEqual([]);
  });
});
