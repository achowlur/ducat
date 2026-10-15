import { describe, expect, it } from 'vitest';
import { matchOverlap, type IncomingRow, type StoredRow } from './overlap';

const day = (d: number, hourUtc = 12) => new Date(Date.UTC(2025, 2, d, hourUtc));
const pdf = (key: string, d: number, amount: number): IncomingRow => ({ key, date: day(d), amount });
const db = (id: string, d: number, amount: number, hourUtc = 12): StoredRow => ({ id, date: day(d, hourUtc), amount });

describe('matchOverlap', () => {
  it('matches a row the database holds under another id, within the window', () => {
    const { verdicts, claimed } = matchOverlap([pdf('a', 3, -12.5)], [db('x', 5, -12.5)], 4, day(1));
    expect(verdicts.get('a')).toEqual({ kind: 'MATCHED', storedId: 'x' });
    expect([...claimed]).toEqual(['x']);
  });

  it('compares a feed instant and a statement date by calendar day', () => {
    const { verdicts } = matchOverlap([pdf('a', 3, -12.5)], [db('x', 7, -12.5, 23)], 4, day(1));
    expect(verdicts.get('a')).toEqual({ kind: 'MATCHED', storedId: 'x' });
  });

  it('never matches a different amount, or a date outside the window', () => {
    const { verdicts } = matchOverlap(
      [pdf('a', 3, -12.5), pdf('b', 3, -40)],
      [db('x', 3, -12.51), db('y', 9, -40)],
      4,
      day(1),
    );
    expect(verdicts.get('a')).toEqual({ kind: 'GAP' });
    expect(verdicts.get('b')).toEqual({ kind: 'GAP' });
  });

  it('calls a row before the stored history NEW, and a hole inside it a GAP', () => {
    const { verdicts } = matchOverlap([pdf('old', 1, -5), pdf('hole', 20, -5)], [], 4, day(10));
    expect(verdicts.get('old')).toEqual({ kind: 'NEW' });
    expect(verdicts.get('hole')).toEqual({ kind: 'GAP' });
    expect(matchOverlap([pdf('a', 1, -5)], [], 4, null).verdicts.get('a')).toEqual({ kind: 'NEW' });
  });

  // Two identical coffees on one day are two rows: only the surplus is missing.
  it('adds only the surplus of interchangeable rows', () => {
    const { verdicts } = matchOverlap(
      [pdf('a', 3, -4.5), pdf('b', 3, -4.5), pdf('c', 3, -4.5)],
      [db('x', 3, -4.5), db('y', 4, -4.5)],
      4,
      day(1),
    );
    const kinds = ['a', 'b', 'c'].map((k) => verdicts.get(k)?.kind);
    expect(kinds.filter((k) => k === 'MATCHED')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'GAP')).toHaveLength(1);
  });

  it('matches as many rows as possible, not the first one greedily', () => {
    // a can reach x or y; b only y. Giving a the earliest it can reach leaves y for b.
    const { verdicts } = matchOverlap([pdf('a', 3, -9), pdf('b', 8, -9)], [db('x', 1, -9), db('y', 6, -9)], 3, day(1));
    expect(verdicts.get('a')).toEqual({ kind: 'MATCHED', storedId: 'x' });
    expect(verdicts.get('b')).toEqual({ kind: 'MATCHED', storedId: 'y' });
  });

  // Which of a and b is the missing one cannot be known: neither is added.
  it('reports a surplus among distinguishable rows as ambiguous', () => {
    const { verdicts } = matchOverlap([pdf('a', 1, -30), pdf('b', 5, -30)], [db('x', 3, -30)], 4, day(1));
    expect(verdicts.get('a')).toEqual({ kind: 'MATCHED', storedId: 'x' });
    expect(verdicts.get('b')).toEqual({ kind: 'AMBIGUOUS', competing: ['a', 'b'] });
  });

  // A card lists a late-posted refund by its original date, months before the
  // period it appeared in; the feed dated it when it posted, in that period.
  it('matches a late-posted row against the period it posted in', () => {
    const late: IncomingRow = { ...pdf('a', 1, 20), postedWithin: { from: day(20), to: day(28) } };
    expect(matchOverlap([late], [db('x', 24, 20)], 4, day(1)).verdicts.get('a')).toEqual({ kind: 'MATCHED', storedId: 'x' });
    // Without the posting range it would be a gap, and stored a second time.
    expect(matchOverlap([pdf('a', 1, 20)], [db('x', 24, 20)], 4, day(1)).verdicts.get('a')).toEqual({ kind: 'GAP' });
  });

  it('never lets two incoming rows claim one stored row', () => {
    const { verdicts, claimed } = matchOverlap([pdf('a', 3, -7), pdf('b', 3, -7)], [db('x', 3, -7)], 4, day(1));
    const matched = ['a', 'b'].filter((k) => verdicts.get(k)?.kind === 'MATCHED');
    expect(matched).toHaveLength(1);
    expect(claimed.size).toBe(1);
  });
});
