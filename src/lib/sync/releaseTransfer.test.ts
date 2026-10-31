import { describe, expect, it } from 'vitest';
import { releaseTransfer } from './releaseTransfer';
import { applyRules, type RuleData, type RuleTxn } from './rules';

const flagged = (partial: Partial<Parameters<typeof releaseTransfer>[0]> = {}) => ({
  flow: 'TRANSFER',
  amount: 120,
  transferPairId: null,
  accountType: 'DEPOSITORY',
  ...partial,
});

describe('releaseTransfer', () => {
  it('gives a word-flagged transfer the flow its amount has, as a decision of the person', () => {
    expect(releaseTransfer(flagged())).toEqual({
      ok: true,
      data: { flow: 'INFLOW', categoryId: null, categorySource: 'MANUAL' },
    });
    expect(releaseTransfer(flagged({ amount: -120 }))).toEqual({
      ok: true,
      data: { flow: 'OUTFLOW', categoryId: null, categorySource: 'MANUAL' },
    });
  });

  it('refuses a row that is no longer a transfer, naming the stale page', () => {
    for (const flow of ['INFLOW', 'OUTFLOW']) {
      const decision = releaseTransfer(flagged({ flow }));
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.message).toMatch(/Reload/);
    }
  });

  it('refuses a paired transfer: the other side is in another account', () => {
    const decision = releaseTransfer(flagged({ transferPairId: 'other-side' }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message).toMatch(/paired/);
  });

  it('refuses inside a closed box, where the account decides', () => {
    const decision = releaseTransfer(flagged({ accountType: 'INVESTMENT' }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message).toMatch(/investment account/);
  });

  it('is never taken back by the rule that flagged the row', () => {
    const rule: RuleData = {
      id: 'user-transfer',
      priority: 50,
      matchField: 'DESCRIPTION',
      matchOperator: 'CONTAINS',
      matchValue: 'zelle from pat',
      setCategoryId: null,
      setFlow: 'TRANSFER',
      enabled: true,
    };
    const txn: RuleTxn = {
      id: 't1',
      amount: 120,
      description: 'ZELLE FROM PAT ON 10/24',
      normalizedMerchant: 'zelle transfer',
      accountName: 'Checking',
      accountType: 'DEPOSITORY',
      categorySource: 'AGGREGATOR',
    };
    expect(applyRules([rule], [txn]).map((a) => a.flow)).toEqual(['TRANSFER']);
    const released = releaseTransfer({ flow: 'TRANSFER', amount: txn.amount, transferPairId: null, accountType: txn.accountType });
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(applyRules([rule], [{ ...txn, categorySource: released.data.categorySource }])).toEqual([]);
  });
});
