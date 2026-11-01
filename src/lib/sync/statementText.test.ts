import { describe, expect, it } from 'vitest';
import { noonUtc, type StatementRow } from '../connectors/pdf/statement';
import { planTextFill } from './statementText';

// Invented rows: a nameless pair of fares on one day, a nameless coffee, and
// a read statement that names them all.
const read: StatementRow[] = [
  { date: noonUtc(2025, 10, 4), description: 'EXAMPLE TRANSIT PAYGO NEW YORK NY', amount: -2.9 },
  { date: noonUtc(2025, 10, 4), description: 'EXAMPLE TRANSIT PAYGO NEW YORK NY', amount: -2.9 },
  { date: noonUtc(2025, 10, 5), description: 'CORNER CAFE SPRINGFIELD IL', amount: -4.5, payee: 'CORNER CAFE' },
  { date: noonUtc(2025, 10, 6), description: 'EXAMPLE GROCER', amount: -31.2 },
];

describe('planTextFill', () => {
  it('names every nameless row the read statement names, by date and amount, as a multiset', () => {
    const plan = planTextFill(
      [
        { id: 'a', date: noonUtc(2025, 10, 4), amount: -2.9 },
        { id: 'b', date: noonUtc(2025, 10, 4), amount: -2.9 },
        { id: 'c', date: noonUtc(2025, 10, 5), amount: -4.5 },
      ],
      read,
    );
    expect(plan.fills).toEqual([
      { id: 'a', description: 'EXAMPLE TRANSIT PAYGO NEW YORK NY' },
      { id: 'b', description: 'EXAMPLE TRANSIT PAYGO NEW YORK NY' },
      { id: 'c', description: 'CORNER CAFE SPRINGFIELD IL', merchantText: 'CORNER CAFE' },
    ]);
    expect(plan.unmatched).toEqual([]);
  });

  it('leaves a row alone when nothing read matches it, or when several different texts could', () => {
    const twoTexts: StatementRow[] = [
      { date: noonUtc(2025, 10, 7), description: 'ONE SHOP', amount: -10 },
      { date: noonUtc(2025, 10, 7), description: 'ANOTHER SHOP', amount: -10 },
    ];
    const plan = planTextFill(
      [
        { id: 'x', date: noonUtc(2025, 10, 7), amount: -10 },
        { id: 'y', date: noonUtc(2025, 10, 9), amount: -99 },
      ],
      [...read, ...twoTexts],
    );
    expect(plan.fills).toEqual([]);
    expect(plan.unmatched.map((r) => r.id)).toEqual(['x', 'y']);
  });

  it('pairs rows one to one when there are as many read rows as nameless ones, texts differing', () => {
    const twoTexts: StatementRow[] = [
      { date: noonUtc(2025, 10, 7), description: 'ONE SHOP', amount: -10 },
      { date: noonUtc(2025, 10, 7), description: 'ANOTHER SHOP', amount: -10 },
    ];
    const plan = planTextFill(
      [
        { id: 'x', date: noonUtc(2025, 10, 7), amount: -10 },
        { id: 'z', date: noonUtc(2025, 10, 7), amount: -10 },
      ],
      twoTexts,
    );
    expect(plan.fills.map((f) => f.description).sort()).toEqual(['ANOTHER SHOP', 'ONE SHOP']);
  });

  it('never fills from a read row that is itself nameless', () => {
    const plan = planTextFill([{ id: 'n', date: noonUtc(2025, 10, 8), amount: -1 }], [{ date: noonUtc(2025, 10, 8), description: '  ', amount: -1 }]);
    expect(plan).toEqual({ fills: [], unmatched: [{ id: 'n', date: noonUtc(2025, 10, 8), amount: -1 }] });
  });
});
