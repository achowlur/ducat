import { describe, expect, it } from 'vitest';
import { computeNetWorthGrowth, marketDaySnapshots } from './netWorth';
import type { AccountData, SnapshotData } from './types';

const eastern = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const at = (iso: string) => new Date(iso);

// Invented: a brokerage the feed polls, and one from statements only.
const brokerage: AccountData = { id: 'brk', type: 'INVESTMENT', balance: 10_300, balanceDate: at('2026-10-02T02:30:00Z'), priorClose: true };
const checking: AccountData = { id: 'chk', type: 'DEPOSITORY', balance: 1_000, balanceDate: at('2026-10-01T19:59:00Z') };

describe('marketDaySnapshots', () => {
  it("dates a polled brokerage's feed snapshot to the end of the market day it values, the local day before its stamp", () => {
    // Stamped 10:30pm Eastern on Oct 1 (02:30 UTC Oct 2): the close of Sep 30.
    const [s] = marketDaySnapshots([{ accountId: 'brk', date: at('2026-10-02T02:30:00Z'), balance: 10_300 }], [brokerage], eastern);
    expect(s.date.toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });

  it("leaves a statement's noon-UTC snapshot, and every other account's, where it is", () => {
    const statement: SnapshotData = { accountId: 'brk', date: at('2026-09-30T12:00:00Z'), balance: 10_250 };
    const bank: SnapshotData = { accountId: 'chk', date: at('2026-10-02T02:30:00Z'), balance: 1_000 };
    expect(marketDaySnapshots([statement, bank], [brokerage, checking], eastern)).toEqual([statement, bank]);
  });
});

describe('a month closes on its last trading day', () => {
  // Evening updates stamped 02:30 UTC the next day, each the previous day's close.
  const feed = (day: string, balance: number): SnapshotData => ({ accountId: 'brk', date: at(`${day}T02:30:00Z`), balance });
  const snapshots = marketDaySnapshots(
    [feed('2026-09-30', 10_000), feed('2026-10-01', 10_200), feed('2026-10-02', 10_300), { accountId: 'chk', date: at('2026-09-30T19:59:00Z'), balance: 1_000 }],
    [brokerage, checking],
    eastern,
  );

  it("takes the first of the month's evening update as the month's close", () => {
    const september = computeNetWorthGrowth([brokerage, checking], snapshots, [], ['2026-09'], 'MONTH').get('2026-09');
    // The Oct 1 evening update (stamped Oct 2 UTC) holds Sep 30's close: 10,300.
    expect(september?.byAccount?.brk).toBe(10_300);
    expect(september?.estimatedAccountIds).toEqual([]);
  });

  it('read by the UTC stamp alone, the same month closed a trading day behind', () => {
    const undated = computeNetWorthGrowth(
      [{ ...brokerage, priorClose: false }, checking],
      [feed('2026-09-30', 10_000), feed('2026-10-01', 10_200), feed('2026-10-02', 10_300), { accountId: 'chk', date: at('2026-09-30T19:59:00Z'), balance: 1_000 }],
      [],
      ['2026-09'],
      'MONTH',
    ).get('2026-09');
    expect(undated?.byAccount?.brk).toBe(10_000);
  });
});
