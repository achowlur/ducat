import { describe, expect, it } from 'vitest';
import { matchAccount } from './matchAccount';

const accounts = [
  { name: 'Brokerage Individual (0001)', externalId: 'ACT-aaa' },
  { name: 'Brokerage Individual (0006)', externalId: 'ACT-bbb' },
  { name: 'RETIREMENT IRA (0002)', externalId: 'ACT-ccc' },
  { name: 'PRIMARY CHECKING ...0003 (0003)', externalId: 'ACT-ddd' },
];

describe('matchAccount', () => {
  it('matches an exact name or external id', () => {
    expect(matchAccount('RETIREMENT IRA (0002)', accounts)?.externalId).toBe('ACT-ccc');
    expect(matchAccount('ACT-bbb', accounts)?.externalId).toBe('ACT-bbb');
  });

  it('matches a masked account number by its digit tail', () => {
    expect(matchAccount('X12345-0001', accounts)?.externalId).toBe('ACT-aaa');
    expect(matchAccount('Z04690006', accounts)?.externalId).toBe('ACT-bbb');
  });

  it('matches a shortened label by substring', () => {
    expect(matchAccount('RETIREMENT IRA', accounts)?.externalId).toBe('ACT-ccc');
  });

  // Two accounts share this prefix; guessing would corrupt both.
  it('refuses an ambiguous label rather than picking one', () => {
    expect(matchAccount('Brokerage Individual', accounts)).toBeNull();
  });

  it('returns null for unknown or empty labels', () => {
    expect(matchAccount('Fidelity Go X8888', accounts)).toBeNull();
    expect(matchAccount('   ', accounts)).toBeNull();
  });
});
