import { describe, expect, it } from 'vitest';
import { assessGoals } from './goals';
import { recentMonths } from './recentMonths';

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

// Invented: a checking account with years of records, a card from long ago,
// a card whose records begin mid-April and one whose records begin mid-July.
const FIRSTS = [day('2019-01-03'), day('2021-05-20'), day('2026-04-27'), day('2026-07-11')];
const COMPLETE = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

describe('recentMonths', () => {
  it('reads the last six complete months, oldest first', () => {
    const w = recentMonths(COMPLETE, [day('2019-01-03')]);
    expect(w.used).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    expect(w.dropped).toEqual([]);
    expect(w.short).toEqual([]);
  });

  it('leaves out a month that reaches back over fewer than two thirds of the accounts', () => {
    // April starts before two of the four accounts' records: 2/4 < 2/3.
    const w = recentMonths(COMPLETE, FIRSTS);
    expect(w.dropped).toEqual([{ period: '2026-04', missing: 2, total: 4 }]);
    expect(w.used).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  });

  it('never reaches further back to replace a month it left out', () => {
    expect(recentMonths(COMPLETE, FIRSTS).used).not.toContain('2026-03');
  });

  it('names a kept month that holds nothing from an account, but not the month an account began in', () => {
    // May and June predate the July card entirely; July holds it from the 11th.
    expect(recentMonths(COMPLETE, FIRSTS).short).toEqual(['2026-05', '2026-06']);
  });

  it('counts an account with no records at all as missing from every month', () => {
    const w = recentMonths(COMPLETE, [day('2019-01-03'), day('2019-01-03'), null]);
    expect(w.used).toHaveLength(6);
    expect(w.short).toHaveLength(6);
  });

  it('says nothing with no accounts to weigh', () => {
    expect(recentMonths(COMPLETE, []).used).toHaveLength(6);
  });

  // The failure this guards: a month from before a card's records began read
  // cheaper than it was, and its net was averaged into the saving pace.
  it('keeps a month that predates most of the spending out of the savings pace', () => {
    const nets: Record<string, number> = {
      '2026-04': 4800, // two cards not yet on record: spending missing, net inflated
      '2026-05': 1500,
      '2026-06': 1500,
      '2026-07': 1500,
      '2026-08': 1500,
      '2026-09': 1500,
    };
    const run = (periods: string[]) =>
      assessGoals({
        goals: [{ id: 'g', name: 'Fund', target: 50_000, accountIds: ['a'] }],
        accounts: [{ id: 'a', name: 'Savings', balance: 10_000 }],
        completeMonthlyNet: periods.map((p) => nets[p]),
        now: day('2026-10-17'),
      })[0];
    expect(run(Object.keys(nets)).monthlyRate).toBe(2050);
    const kept = run(recentMonths(Object.keys(nets), FIRSTS).used);
    expect(kept.monthlyRate).toBe(1500);
    expect(kept.basisMonths).toBe(5);
  });
});
