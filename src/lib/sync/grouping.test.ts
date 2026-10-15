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
    expect(payeeKey('ZELLE TO  JANE DOE ON 07/21 REF # WFCT0000000A')).toBe('zelle to jane doe');
    expect(payeeKey('ZELLE TO SMITH JOHN ON 07/19 REF # WFCT0000000B')).toBe('zelle to smith john');
  });

  // The key becomes a rule's CONTAINS value, matched against the description
  // itself — so it must stay a contiguous prefix. Venmo puts its reference
  // numbers BETWEEN the verb and the name; deleting them mid-string produced
  // "venmo payment jane doe", which appears nowhere in the description.
  it('truncates at mid-string noise so the key stays a substring of the description', () => {
    const description = 'VENMO            PAYMENT    260704 1000000000001   JANE DOE';
    const key = payeeKey(description);
    expect(key).toBe('venmo payment');
    expect(description.toLowerCase().replace(/\s+/g, ' ')).toContain(key);
  });

  it('keeps every derived key findable in its own description', () => {
    for (const description of [
      'ZELLE TO  JANE DOE ON 07/21 REF # WFCT0000000A',
      'ZELLE FROM DOE MARY ON 06/10 REF # WFCT0000000D FOR BIRTHDAY GIFT',
      'VENMO            CASHOUT    260220 1000000000002   JANE',
    ]) {
      const key = payeeKey(description);
      expect(key).not.toBe('');
      expect(description.toLowerCase().replace(/\s+/g, ' ')).toContain(key);
    }
  });

  it('collapses the same counterparty across different dates and refs', () => {
    const a = payeeKey('ZELLE TO  JANE DOE ON 07/21 REF # WFCT0000000A');
    const b = payeeKey('ZELLE TO  JANE DOE ON 07/18 REF # WFCT0000000C');
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
      txn({ id: '1', normalizedMerchant: 'zelle transfer', description: 'ZELLE TO JANE DOE ON 07/21 REF # AAA' }),
      txn({ id: '2', normalizedMerchant: 'zelle transfer', description: 'ZELLE TO JANE DOE ON 07/18 REF # BBB' }),
      txn({ id: '3', normalizedMerchant: 'zelle transfer', description: 'ZELLE TO SMITH JOHN ON 07/19 REF # CCC' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['zelle to jane doe', 'zelle to smith john']);
    expect(groups.every((g) => g.matchField === 'DESCRIPTION' && g.isP2P)).toBe(true);
    expect(groups[0].count).toBe(2);
  });

  // A card-network P2P payment cuts at its date to "purchase authorized", the
  // bank's bookkeeping. Keyed on that, one decision wrote DESCRIPTION CONTAINS
  // "purchase authorized" at user priority: every debit card purchase on the
  // account, recategorized from a row that showed only Venmo payments.
  it('keys a card-network P2P payment on its merchant, never on the bank bookkeeping', () => {
    const groups = groupByPayee([
      txn({ id: '1', normalizedMerchant: 'venmo* visa direct ny', description: 'Purchase authorized on 03/14 Venmo* VISA Direct NY S0000000000000001 Card 1234' }),
      txn({ id: '2', normalizedMerchant: 'venmo* visa direct ny', description: 'Purchase authorized on 04/02 Venmo* VISA Direct NY S0000000000000002 Card 1234' }),
      txn({ id: '3', normalizedMerchant: 'paypal *studyapp', description: 'Recurring Payment authorized on 03/05 Paypal *Studyapp 4020000000 CA S0000000000000003 Card 1234' }),
      txn({ id: '4', normalizedMerchant: 'river bakery', description: 'Purchase authorized on 03/15 River Bakery Fairview IL S0000000000000004 Card 1234' }),
    ]);
    expect(groups.map((g) => [g.key, g.matchField, g.isP2P])).toEqual([
      ['venmo* visa direct ny', 'MERCHANT', true],
      ['paypal *studyapp', 'MERCHANT', true],
      ['river bakery', 'MERCHANT', false],
    ]);
  });

  it('keeps a P2P row on its description when the merchant is only the rail', () => {
    // The fallback needs a merchant that names someone: "zelle transfer" names
    // no one, and as a MERCHANT rule it is every Zelle payment at once.
    const groups = groupByPayee([
      txn({ id: '1', normalizedMerchant: 'zelle transfer', description: 'ONLINE PAYMENT TO JANE DOE ON 07/21 REF # AAA' }),
    ]);
    expect(groups[0]).toMatchObject({ key: 'online payment to jane doe', matchField: 'DESCRIPTION' });
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
