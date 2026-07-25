import { describe, expect, it } from 'vitest';
import { groupByPayee, payeeKey, type GroupTxn } from './grouping';

const txn = (partial: Partial<GroupTxn> & { id: string }): GroupTxn => ({
  amount: -10,
  description: 'SOMETHING',
  normalizedMerchant: 'something',
  flow: 'OUTFLOW',
  ...partial,
});

describe('payeeKey', () => {
  it('strips reference numbers, dates, and doubled spaces from P2P descriptions', () => {
    expect(payeeKey('ZELLE TO  LENA ON 07/21 REF # WFCT0000000E')).toBe('zelle to lena');
    expect(payeeKey('ZELLE TO HOLLIS AMARI ON 07/19 REF # WFCT0000000H')).toBe('zelle to hollis amari');
  });

  it('collapses the same counterparty across different dates and refs', () => {
    const a = payeeKey('ZELLE TO  LENA ON 07/21 REF # WFCT0000000E');
    const b = payeeKey('ZELLE TO  LENA ON 07/18 REF # WFCT0000000J');
    expect(a).toBe(b);
  });
});

describe('groupByPayee', () => {
  it('groups ordinary merchants by normalized merchant and matches MERCHANT', () => {
    const groups = groupByPayee([
      txn({ id: '1', normalizedMerchant: 'cold stone creamery', amount: -8 }),
      txn({ id: '2', normalizedMerchant: 'cold stone creamery', amount: -12 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: 'cold stone creamery',
      matchField: 'MERCHANT',
      isP2P: false,
      count: 2,
      total: 20,
    });
    expect(groups[0].transactionIds).toEqual(['1', '2']);
  });

  it('splits P2P by counterparty instead of lumping the whole rail together', () => {
    const groups = groupByPayee([
      txn({ id: '1', normalizedMerchant: 'zelle transfer', description: 'ZELLE TO LENA ON 07/21 REF # AAA' }),
      txn({ id: '2', normalizedMerchant: 'zelle transfer', description: 'ZELLE TO LENA ON 07/18 REF # BBB' }),
      txn({ id: '3', normalizedMerchant: 'zelle transfer', description: 'ZELLE TO HOLLIS AMARI ON 07/19 REF # CCC' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['zelle to lena', 'zelle to hollis amari']);
    expect(groups.every((g) => g.matchField === 'DESCRIPTION' && g.isP2P)).toBe(true);
    expect(groups[0].count).toBe(2);
  });

  it('orders by count so the highest-leverage decisions come first', () => {
    const groups = groupByPayee([
      txn({ id: '1', normalizedMerchant: 'rare' }),
      ...Array.from({ length: 5 }, (_, i) => txn({ id: `c${i}`, normalizedMerchant: 'common' })),
      ...Array.from({ length: 3 }, (_, i) => txn({ id: `m${i}`, normalizedMerchant: 'middle' })),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['common', 'middle', 'rare']);
  });

  it('marks a group MIXED when its transactions disagree on flow', () => {
    const groups = groupByPayee([
      txn({ id: '1', normalizedMerchant: 'fidelity', flow: 'INFLOW' }),
      txn({ id: '2', normalizedMerchant: 'fidelity', flow: 'OUTFLOW' }),
    ]);
    expect(groups[0].flow).toBe('MIXED');
  });

  it('falls back to the description when a merchant has no normalized form', () => {
    const groups = groupByPayee([
      txn({ id: '1', normalizedMerchant: '', description: 'DIVIDEND RECEIVED 1234567' }),
    ]);
    expect(groups[0].key).toBe('dividend received');
    expect(groups[0].matchField).toBe('MERCHANT');
  });
});
