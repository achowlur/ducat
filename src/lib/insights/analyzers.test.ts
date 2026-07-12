import { describe, expect, it } from 'vitest';
import type { TransactionFlow } from '../../types/contracts';
import { detectCategoryTotalAnomalies, detectTransactionAnomalies } from './anomalies';
import { computeCashFlowTrend } from './cashFlow';
import { balanceAt, computeNetWorthGrowth } from './netWorth';
import { detectRecurringCharges } from './recurring';
import { computeSpendingByCategory } from './spendingByCategory';
import type { AccountData, SnapshotData, TxnData } from './types';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

let nextId = 0;
function txn(partial: Partial<TxnData> & { date: Date; amount: number }): TxnData {
  const flow: TransactionFlow = partial.flow ?? (partial.amount >= 0 ? 'INFLOW' : 'OUTFLOW');
  return {
    id: partial.id ?? `t${++nextId}`,
    accountId: partial.accountId ?? 'acc1',
    description: partial.description ?? 'desc',
    normalizedMerchant: partial.normalizedMerchant ?? 'merchant',
    categoryId: partial.categoryId ?? null,
    categoryName: partial.categoryName ?? null,
    ...partial,
    flow,
  };
}

const groceries = { categoryId: 'cat-groceries', categoryName: 'Groceries' };

describe('balanceAt', () => {
  const account: AccountData = {
    id: 'acc1',
    type: 'DEPOSITORY',
    balance: 1000,
    balanceDate: utc(2026, 7, 12),
  };

  it('reconstructs backwards from current balance when no snapshots exist', () => {
    const txns = [
      txn({ date: utc(2026, 7, 5), amount: -200 }),
      txn({ date: utc(2026, 7, 10), amount: 500 }),
    ];
    // End of June: remove July's transactions from the current balance.
    const result = balanceAt(account, [], txns, utc(2026, 6, 30));
    expect(result.balance).toBe(700);
    expect(result.estimated).toBe(true);
  });

  it('rolls a snapshot forward with subsequent transactions', () => {
    const snapshots: SnapshotData[] = [{ accountId: 'acc1', date: utc(2026, 6, 30), balance: 800 }];
    const txns = [
      txn({ date: utc(2026, 7, 5), amount: -200 }),
      txn({ date: utc(2026, 6, 15), amount: -999 }), // before snapshot, must not count
    ];
    const result = balanceAt(account, snapshots, txns, utc(2026, 7, 31));
    expect(result.balance).toBe(600);
    expect(result.estimated).toBe(false);
  });

  it('includes TRANSFER transactions in balance math', () => {
    const txns = [txn({ date: utc(2026, 7, 5), amount: -300, flow: 'TRANSFER' })];
    const result = balanceAt(account, [], txns, utc(2026, 6, 30));
    expect(result.balance).toBe(1300);
  });
});

describe('computeNetWorthGrowth', () => {
  it('computes growth rate between consecutive periods', () => {
    const account: AccountData = {
      id: 'acc1', type: 'DEPOSITORY', balance: 1100, balanceDate: utc(2026, 7, 12),
    };
    const txns = [txn({ date: utc(2026, 7, 3), amount: 100 })];
    const result = computeNetWorthGrowth([account], [], txns, ['2026-06', '2026-07'], 'MONTH');

    const june = result.get('2026-06');
    const july = result.get('2026-07');
    expect(june?.netWorth).toBe(1000);
    expect(june?.growthRate).toBeNull(); // 2026-05 not in scope
    expect(july?.netWorth).toBe(1100);
    expect(july?.previousNetWorth).toBe(1000);
    expect(july?.growthRate).toBe(0.1);
    expect(july?.estimatedAccountIds).toEqual(['acc1']);
  });
});

describe('computeSpendingByCategory', () => {
  it('sums outflows per category and excludes transfers', () => {
    const txns = [
      txn({ date: utc(2026, 7, 2), amount: -50, ...groceries }),
      txn({ date: utc(2026, 7, 9), amount: -30, ...groceries }),
      txn({ date: utc(2026, 7, 5), amount: -500, flow: 'TRANSFER' }),
      txn({ date: utc(2026, 7, 1), amount: 2000 }), // income, not spending
      txn({ date: utc(2026, 6, 2), amount: -40, ...groceries }),
    ];
    const result = computeSpendingByCategory(txns, ['2026-06', '2026-07'], 'MONTH');
    const july = result.get('2026-07');
    expect(july?.totalSpending).toBe(80);
    expect(july?.previousTotalSpending).toBe(40);
    expect(july?.categories).toEqual([
      {
        categoryId: 'cat-groceries',
        categoryName: 'Groceries',
        spending: 80,
        previousSpending: 40,
        deltaPct: 1,
      },
    ]);
  });
});

describe('computeCashFlowTrend', () => {
  it('tracks income, spending, net, and deltas', () => {
    const txns = [
      txn({ date: utc(2026, 6, 1), amount: 1000 }),
      txn({ date: utc(2026, 6, 10), amount: -400 }),
      txn({ date: utc(2026, 7, 1), amount: 1200 }),
      txn({ date: utc(2026, 7, 10), amount: -600 }),
      txn({ date: utc(2026, 7, 15), amount: -800, flow: 'TRANSFER' }),
    ];
    const result = computeCashFlowTrend(txns, ['2026-06', '2026-07'], 'MONTH');
    const july = result.get('2026-07');
    expect(july).toEqual({
      granularity: 'MONTH',
      income: 1200,
      spending: 600,
      net: 600,
      previousIncome: 1000,
      previousSpending: 400,
      previousNet: 600,
      incomeDeltaPct: 0.2,
      spendingDeltaPct: 0.5,
    });
  });
});

describe('detectRecurringCharges', () => {
  const monthly = (amounts: number[], merchant = 'netflix'): TxnData[] =>
    amounts.map((a, i) => txn({ date: utc(2026, i + 1, 10), amount: -a, normalizedMerchant: merchant }));

  it('detects a monthly subscription and flags a price increase', () => {
    const txns = monthly([15.99, 15.99, 15.99, 15.99, 18.99]);
    const result = detectRecurringCharges(txns);
    const netflix = result.get('netflix');
    expect(netflix?.cadence).toBe('MONTHLY');
    expect(netflix?.occurrences).toBe(5);
    expect(netflix?.averageAmount).toBe(15.99);
    expect(netflix?.lastAmount).toBe(18.99);
    expect(netflix?.priceIncreased).toBe(true);
  });

  it('does not flag a stable price as increased', () => {
    const result = detectRecurringCharges(monthly([15.99, 15.99, 15.99, 15.99]));
    expect(result.get('netflix')?.priceIncreased).toBe(false);
  });

  it('ignores merchants with too few or irregular occurrences', () => {
    const twoOnly = monthly([9.99, 9.99]).slice(0, 2);
    expect(detectRecurringCharges(twoOnly).size).toBe(0);

    const irregular = [
      txn({ date: utc(2026, 1, 3), amount: -60, normalizedMerchant: 'whole foods' }),
      txn({ date: utc(2026, 1, 7), amount: -25, normalizedMerchant: 'whole foods' }),
      txn({ date: utc(2026, 3, 22), amount: -110, normalizedMerchant: 'whole foods' }),
      txn({ date: utc(2026, 4, 2), amount: -45, normalizedMerchant: 'whole foods' }),
    ];
    expect(detectRecurringCharges(irregular).size).toBe(0);
  });

  it('detects weekly cadence', () => {
    const txns = [1, 8, 15, 22, 29].map((d) =>
      txn({ date: utc(2026, 6, d), amount: -12.5, normalizedMerchant: 'car wash club' }),
    );
    expect(detectRecurringCharges(txns).get('car wash club')?.cadence).toBe('WEEKLY');
  });

  it('treats per-ride public transit fares as individual charges, but a monthly pass as recurring', () => {
    // Weekday commuter: flat $7.52 fare, Mon-Fri rides across two months.
    // Identical amounts, but ride gaps (1-3 days) sit below every cadence
    // band, so this must NOT read as a subscription.
    const rides: TxnData[] = [];
    for (const month of [5, 6] as const) {
      for (let day = 1; day <= 28; day++) {
        const weekday = utc(2026, month, day).getUTCDay();
        if (weekday === 0 || weekday === 6) continue;
        rides.push(txn({ date: utc(2026, month, day), amount: -2.9, normalizedMerchant: 'trc metrocard' }));
      }
    }
    expect(detectRecurringCharges(rides).size).toBe(0);

    // The same commuter on a monthly pass IS a subscription: one fixed
    // charge on the 1st of each month.
    const pass = [1, 2, 3, 4, 5, 6].map((m) =>
      txn({ date: utc(2026, m, 1), amount: -127, normalizedMerchant: 'trc monthly pass' }),
    );
    const detected = detectRecurringCharges(pass).get('trc monthly pass');
    expect(detected?.cadence).toBe('MONTHLY');
    expect(detected?.averageAmount).toBe(127);
  });
});

describe('investment purchases (Fidelity-style brokerage)', () => {
  // The normalization contract: brokerage trades and contributions are
  // TRANSFERs (cash changing form, not leaving net worth), so they must
  // never appear in spending analytics.
  const july = (d: number) => utc(2026, 7, d);
  const base = [
    txn({ date: july(1), amount: 5000, accountId: 'checking', normalizedMerchant: 'acme corp' }),
    txn({ date: july(3), amount: -200, accountId: 'checking', ...groceries }),
    // Contribution pair: checking -> Fidelity
    txn({ date: july(5), amount: -1000, accountId: 'checking', flow: 'TRANSFER', normalizedMerchant: 'fidelity' }),
    txn({ date: july(5), amount: 1000, accountId: 'fidelity', flow: 'TRANSFER', normalizedMerchant: 'fidelity' }),
  ];

  it('counts a stock buy normalized as TRANSFER as investing, not spending', () => {
    const buy = txn({
      date: july(6), amount: -950, accountId: 'fidelity', flow: 'TRANSFER',
      description: 'BUY 5 AAPL', normalizedMerchant: 'fidelity',
    });
    const cashFlow = computeCashFlowTrend([...base, buy], ['2026-07'], 'MONTH').get('2026-07');
    expect(cashFlow?.income).toBe(5000);
    expect(cashFlow?.spending).toBe(200); // groceries only
    expect(cashFlow?.net).toBe(4800);

    const spending = computeSpendingByCategory([...base, buy], ['2026-07'], 'MONTH').get('2026-07');
    expect(spending?.totalSpending).toBe(200);
    expect(spending?.categories.map((c) => c.categoryName)).toEqual(['Groceries']);
  });

  it('shows why connectors must normalize trades: an OUTFLOW-mislabeled buy inflates spending', () => {
    const mislabeled = txn({
      date: july(6), amount: -950, accountId: 'fidelity', flow: 'OUTFLOW',
      description: 'BUY 5 AAPL', normalizedMerchant: 'fidelity',
    });
    const cashFlow = computeCashFlowTrend([...base, mislabeled], ['2026-07'], 'MONTH').get('2026-07');
    // The engine trusts flow labels — a mislabeled trade counts as spending.
    // Correct classification is the connector layer's job (Session 3).
    expect(cashFlow?.spending).toBe(1150);
  });
});

describe('detectTransactionAnomalies', () => {
  const history = Array.from({ length: 8 }, (_, i) =>
    txn({ date: utc(2026, i + 1 <= 6 ? i + 1 : 6, (i % 27) + 1), amount: -(60 + i * 3), ...groceries }),
  );

  it('flags a transaction far outside its category history', () => {
    const spike = txn({ id: 'spike', date: utc(2026, 7, 8), amount: -900, ...groceries });
    const result = detectTransactionAnomalies([...history, spike], '2026-07', 'MONTH');
    expect(result).toHaveLength(1);
    expect(result[0].transactionId).toBe('spike');
    expect(result[0].amount).toBe(900);
    expect(result[0].deviation).toBeGreaterThanOrEqual(3.5);
  });

  it('ignores normal-sized transactions and thin history', () => {
    const normal = txn({ date: utc(2026, 7, 8), amount: -72, ...groceries });
    expect(detectTransactionAnomalies([...history, normal], '2026-07', 'MONTH')).toHaveLength(0);

    const thinHistory = history.slice(0, 3);
    const spike = txn({ date: utc(2026, 7, 8), amount: -900, ...groceries });
    expect(detectTransactionAnomalies([...thinHistory, spike], '2026-07', 'MONTH')).toHaveLength(0);
  });
});

describe('detectCategoryTotalAnomalies', () => {
  it('flags a category whose period total explodes vs prior periods', () => {
    const periods = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
    const txns: TxnData[] = [];
    for (let m = 1; m <= 6; m++) {
      txns.push(txn({ date: utc(2026, m, 10), amount: -(95 + m), ...groceries }));
    }
    txns.push(txn({ date: utc(2026, 7, 10), amount: -1500, ...groceries }));

    const result = detectCategoryTotalAnomalies(txns, '2026-07', periods, 'MONTH');
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('CATEGORY_TOTAL');
    expect(result[0].categoryId).toBe('cat-groceries');
    expect(result[0].amount).toBe(1500);
  });

  it('stays quiet when the period is in line with history', () => {
    const periods = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
    const txns: TxnData[] = [];
    for (let m = 1; m <= 7; m++) {
      txns.push(txn({ date: utc(2026, m, 10), amount: -(95 + m), ...groceries }));
    }
    expect(detectCategoryTotalAnomalies(txns, '2026-07', periods, 'MONTH')).toHaveLength(0);
  });
});
