import { describe, expect, it } from 'vitest';
import type { TransactionFlow } from '../../types/contracts';
import {
  detectCategoryTotalAnomalies,
  detectTransactionAnomalies,
  DEFAULT_ANOMALY_OPTIONS,
} from './anomalies';
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
    categoryIsIncome: partial.categoryIsIncome ?? false,
    reimbursesId: partial.reimbursesId ?? null,
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

  // A brokerage's worth moves with the market, which leaves no transaction.
  // Every "YOU BOUGHT" is cash leaving with no entry for what it bought, so
  // rolling today's balance backwards through trades invents a past balance.
  it('refuses to reconstruct an investment account with no snapshot', () => {
    const brokerage: AccountData = { id: 'acc2', type: 'INVESTMENT', balance: 197040, balanceDate: utc(2026, 7, 12) };
    const txns = [txn({ accountId: 'acc2', date: utc(2026, 7, 5), amount: -1010 })];
    expect(balanceAt(brokerage, [], txns, utc(2026, 6, 30)).known).toBe(false);
  });

  it('knows an investment balance once a snapshot backs it', () => {
    const brokerage: AccountData = { id: 'acc2', type: 'INVESTMENT', balance: 197040, balanceDate: utc(2026, 7, 12) };
    const snapshots: SnapshotData[] = [{ accountId: 'acc2', date: utc(2026, 6, 30), balance: 150000 }];
    const result = balanceAt(brokerage, snapshots, [], utc(2026, 7, 31));
    expect(result).toMatchObject({ balance: 150000, known: true });
  });

  // A month with no value of its own carries the last one, saying so: only
  // that month's market movement goes unseen (the operator's choice, 2026-10-15).
  it('carries the last investment value into a later period, marked estimated', () => {
    const brokerage: AccountData = { id: 'acc2', type: 'INVESTMENT', balance: 197040, balanceDate: utc(2026, 7, 12) };
    const snapshots: SnapshotData[] = [{ accountId: 'acc2', date: utc(2026, 6, 30), balance: 150000 }];
    const july = balanceAt(brokerage, snapshots, [], utc(2026, 7, 31), {
      investmentSnapshotNotBefore: utc(2026, 7, 1),
    });
    expect(july).toEqual({ balance: 150000, estimated: true, known: true, carried: true });
  });

  // A deposit is no market movement and is known; a trade moves nothing across.
  it('adds money that crossed the account since to a carried value, never a trade', () => {
    const brokerage: AccountData = { id: 'acc2', type: 'INVESTMENT', balance: 197040, balanceDate: utc(2026, 7, 12) };
    const snapshots: SnapshotData[] = [{ accountId: 'acc2', date: utc(2026, 6, 30), balance: 150000 }];
    const txns = [
      txn({ accountId: 'acc2', date: utc(2026, 7, 9), amount: 512.37, description: 'EFT FUNDS RECEIVED' }),
      txn({ accountId: 'acc2', date: utc(2026, 7, 10), amount: -318.06, description: 'YOU BOUGHT EXAMPLE INDEX FUND' }),
    ];
    const july = balanceAt(brokerage, snapshots, txns, utc(2026, 7, 31), { investmentSnapshotNotBefore: utc(2026, 7, 1) });
    expect(july).toEqual({ balance: 150512.37, estimated: true, known: true, carried: true });
  });

  // An opening zero (a first statement's opening day) says the account held nothing before.
  it('counts an account as zero before its opening zero, unless it moved money before then', () => {
    const opened: AccountData = { id: 'acc5', type: 'INVESTMENT', balance: 3027.88, balanceDate: utc(2026, 3, 31) };
    const snapshots: SnapshotData[] = [
      { accountId: 'acc5', date: utc(2026, 3, 1), balance: 0 },
      { accountId: 'acc5', date: utc(2026, 3, 31), balance: 3027.88 },
    ];
    const january = { investmentSnapshotNotBefore: utc(2026, 1, 1) };
    expect(balanceAt(opened, snapshots, [], utc(2026, 1, 31), january)).toEqual({ balance: 0, estimated: false, known: true });
    const earlier = [txn({ accountId: 'acc5', date: utc(2026, 1, 10), amount: 512.37, description: 'EFT FUNDS RECEIVED' })];
    expect(balanceAt(opened, snapshots, earlier, utc(2026, 1, 31), january).known).toBe(false);
  });

  // Any account type: a card opened by its first statement held nothing before, whatever a reconstruction says.
  it('counts a card as zero before its opening zero, not as a reconstruction', () => {
    const card: AccountData = { id: 'acc8', type: 'CREDIT', balance: -318.06, balanceDate: utc(2026, 3, 31) };
    const snapshots: SnapshotData[] = [{ accountId: 'acc8', date: utc(2026, 3, 1), balance: 0 }];
    const txns = [txn({ accountId: 'acc8', date: utc(2026, 3, 9), amount: -318.06 })];
    expect(balanceAt(card, snapshots, txns, utc(2026, 1, 31))).toEqual({ balance: 0, estimated: false, known: true });
  });

  // Records that simply start late cannot say what came before.
  it('does not know an account whose first value is not an opening zero, before it', () => {
    const late: AccountData = { id: 'acc6', type: 'INVESTMENT', balance: 2914.06, balanceDate: utc(2026, 3, 31) };
    const snapshots: SnapshotData[] = [{ accountId: 'acc6', date: utc(2026, 3, 31), balance: 2914.06 }];
    expect(balanceAt(late, snapshots, [], utc(2026, 1, 31), { investmentSnapshotNotBefore: utc(2026, 1, 1) }).known).toBe(false);
  });

  it('accepts a snapshot taken inside the period being asked about', () => {
    const brokerage: AccountData = { id: 'acc2', type: 'INVESTMENT', balance: 197040, balanceDate: utc(2026, 7, 12) };
    const snapshots: SnapshotData[] = [{ accountId: 'acc2', date: utc(2026, 7, 25), balance: 197040 }];
    const result = balanceAt(brokerage, snapshots, [], utc(2026, 7, 31), {
      investmentSnapshotNotBefore: utc(2026, 7, 1),
    });
    expect(result).toMatchObject({ balance: 197040, known: true });
  });

  // A brokerage snapshot is the TOTAL worth; a buy shifts cash into securities
  // inside it and changes nothing. SimpleFIN reports trades as plain OUTFLOWs,
  // so rolling forward would subtract the whole purchase from net worth.
  it('does not apply an investment account\'s own trades to its snapshot', () => {
    const brokerage: AccountData = { id: 'acc2', type: 'INVESTMENT', balance: 250_000, balanceDate: utc(2026, 7, 1) };
    const snapshots: SnapshotData[] = [{ accountId: 'acc2', date: utc(2026, 7, 1), balance: 250_000 }];
    const buy = [txn({ accountId: 'acc2', date: utc(2026, 7, 10), amount: -20_000 })];
    const result = balanceAt(brokerage, snapshots, buy, utc(2026, 7, 31), {
      investmentSnapshotNotBefore: utc(2026, 7, 1),
    });
    expect(result.balance).toBe(250_000);
    expect(result.estimated).toBe(true); // a Jul 1 snapshot is not the Jul 31 value
  });

  // Cash and credit are fully explained by their transactions, so a snapshot
  // from any point still rolls forward correctly — the bound is market-only.
  it('still rolls a cash snapshot forward across periods', () => {
    const snapshots: SnapshotData[] = [{ accountId: 'acc1', date: utc(2026, 6, 30), balance: 800 }];
    const result = balanceAt(account, snapshots, [], utc(2026, 7, 31), {
      investmentSnapshotNotBefore: utc(2026, 7, 1),
    });
    expect(result).toMatchObject({ balance: 800, known: true });
  });

  // An empty (closed) account has no market exposure, so its zero is no guess;
  // money in since it was last valued makes it unknown again.
  it("carries an investment account's zero forward while nothing moves in", () => {
    const closed: AccountData = { id: 'acc3', type: 'INVESTMENT', balance: 0, balanceDate: utc(2026, 1, 31) };
    const snapshots: SnapshotData[] = [{ accountId: 'acc3', date: utc(2026, 1, 31), balance: 0 }];
    const march = { investmentSnapshotNotBefore: utc(2026, 3, 1) };
    expect(balanceAt(closed, snapshots, [], utc(2026, 3, 31), march)).toEqual({ balance: 0, estimated: false, known: true });
    const deposit = [txn({ accountId: 'acc3', date: utc(2026, 2, 10), amount: 512.37, description: 'EFT FUNDS RECEIVED' })];
    expect(balanceAt(closed, snapshots, deposit, utc(2026, 3, 31), march)).toEqual({ balance: 512.37, estimated: true, known: true, carried: true });
  });
});

describe('computeNetWorthGrowth', () => {
  // Otherwise a closed brokerage would erase net worth for every month after it.
  it('stays known after an investment account closes at zero', () => {
    const open: AccountData = { id: 'acc4', type: 'INVESTMENT', balance: 3027.88, balanceDate: utc(2026, 3, 31) };
    const closed: AccountData = { id: 'acc3', type: 'INVESTMENT', balance: 0, balanceDate: utc(2026, 1, 31) };
    const snapshots: SnapshotData[] = [
      { accountId: 'acc3', date: utc(2026, 1, 31), balance: 0 },
      { accountId: 'acc4', date: utc(2026, 2, 28), balance: 2914.06 },
      { accountId: 'acc4', date: utc(2026, 3, 31), balance: 3027.88 },
    ];
    const result = computeNetWorthGrowth([open, closed], snapshots, [], ['2026-02', '2026-03'], 'MONTH');
    expect([result.get('2026-02')?.netWorth, result.get('2026-03')?.netWorth]).toEqual([2914.06, 3027.88]);
  });

  // A month leaves out, by name, an account it cannot know; it is not dropped whole.
  it('leaves out an account it cannot know for a month, and compares no growth across it', () => {
    const cash: AccountData = { id: 'acc7', type: 'DEPOSITORY', balance: 2914.06, balanceDate: utc(2026, 3, 31) };
    const late: AccountData = { id: 'acc6', type: 'INVESTMENT', balance: 3027.88, balanceDate: utc(2026, 3, 31) };
    const snapshots: SnapshotData[] = [
      { accountId: 'acc7', date: utc(2026, 1, 31), balance: 2914.06 },
      { accountId: 'acc7', date: utc(2026, 2, 28), balance: 2914.06 },
      { accountId: 'acc7', date: utc(2026, 3, 31), balance: 2914.06 },
      { accountId: 'acc6', date: utc(2026, 3, 31), balance: 3027.88 },
    ];
    const result = computeNetWorthGrowth([cash, late], snapshots, [], ['2026-01', '2026-02', '2026-03'], 'MONTH');
    expect(result.get('2026-02')).toMatchObject({ netWorth: 2914.06, excludedAccountIds: ['acc6'], growthRate: 0 });
    expect(result.get('2026-03')).toMatchObject({ netWorth: 5941.94, excludedAccountIds: [], growthRate: null, marketGains: null });
  });

  // The net worth goal splits net worth by the operator's cash definition,
  // a line the account type cannot draw, so each account's value travels.
  it("records each account's month-end value, adding up to net worth, a left-out account absent", () => {
    const cash: AccountData = { id: 'acc7', type: 'DEPOSITORY', balance: 2914.06, balanceDate: utc(2026, 3, 31) };
    const late: AccountData = { id: 'acc6', type: 'INVESTMENT', balance: 3027.88, balanceDate: utc(2026, 3, 31) };
    const snapshots: SnapshotData[] = [
      { accountId: 'acc7', date: utc(2026, 2, 28), balance: 2914.06 },
      { accountId: 'acc7', date: utc(2026, 3, 31), balance: 2914.06 },
      { accountId: 'acc6', date: utc(2026, 3, 31), balance: 3027.88 },
    ];
    const result = computeNetWorthGrowth([cash, late], snapshots, [], ['2026-02', '2026-03'], 'MONTH');
    expect(result.get('2026-02')?.byAccount).toEqual({ acc7: 2914.06 });
    expect(result.get('2026-03')?.byAccount).toEqual({ acc7: 2914.06, acc6: 3027.88 });
    const march = result.get('2026-03')!;
    expect(Object.values(march.byAccount!).reduce((s, v) => s + v, 0)).toBeCloseTo(march.netWorth, 2);
  });

  it('records money crossing each investment account, trades inside it left out', () => {
    const brokerage: AccountData = { id: 'acc8', type: 'INVESTMENT', balance: 5000, balanceDate: utc(2026, 3, 31) };
    const snapshots: SnapshotData[] = [
      { accountId: 'acc8', date: utc(2026, 2, 28), balance: 3000 },
      { accountId: 'acc8', date: utc(2026, 3, 31), balance: 5000 },
    ];
    const txns = [
      txn({ accountId: 'acc8', date: utc(2026, 3, 3), amount: 400, description: 'ELECTRONIC FUNDS TRANSFER RECEIVED', flow: 'TRANSFER' }),
      txn({ accountId: 'acc8', date: utc(2026, 3, 5), amount: -400, description: 'YOU BOUGHT INDEX FUND', flow: 'TRANSFER' }),
    ];
    const march = computeNetWorthGrowth([brokerage], snapshots, txns, ['2026-02', '2026-03'], 'MONTH').get('2026-03')!;
    expect(march.investmentFlowsByAccount).toEqual({ acc8: 400 });
    expect(march.investmentNetFlows).toBe(400);
  });

  // A cash account's yield is read from what it was PAID, never its change
  // in value: a reinvestment, a card's interest charge and a deposit are not.
  it('records the interest and dividends each bank or investment account was paid', () => {
    const savings: AccountData = { id: 'acc9', type: 'DEPOSITORY', balance: 10000, balanceDate: utc(2026, 3, 31) };
    const moneyMarket: AccountData = { id: 'acc10', type: 'INVESTMENT', balance: 20000, balanceDate: utc(2026, 3, 31) };
    const card: AccountData = { id: 'acc11', type: 'CREDIT', balance: -500, balanceDate: utc(2026, 3, 31) };
    const snapshots: SnapshotData[] = [
      { accountId: 'acc9', date: utc(2026, 3, 31), balance: 10000 },
      { accountId: 'acc10', date: utc(2026, 3, 31), balance: 20000 },
      { accountId: 'acc11', date: utc(2026, 3, 31), balance: -500 },
    ];
    const txns = [
      txn({ accountId: 'acc9', date: utc(2026, 3, 28), amount: 31.25, description: 'INTEREST PAYMENT' }),
      txn({ accountId: 'acc9', date: utc(2026, 3, 3), amount: 5000, description: 'TRANSFER FROM CHECKING' }),
      txn({ accountId: 'acc10', date: utc(2026, 3, 31), amount: -54.1, description: 'DIVIDEND RECEIVED GOVERNMENT MONEY MARKET' }),
      txn({ accountId: 'acc10', date: utc(2026, 3, 31), amount: 54.1, description: 'REINVESTMENT GOVERNMENT MONEY MARKET' }),
      txn({ accountId: 'acc11', date: utc(2026, 3, 20), amount: -12.4, description: 'INTEREST CHARGE ON PURCHASES' }),
    ];
    const march = computeNetWorthGrowth([savings, moneyMarket, card], snapshots, txns, ['2026-03'], 'MONTH').get('2026-03')!;
    expect(march.interestByAccount).toEqual({ acc9: 31.25, acc10: 54.1 });
  });

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

describe('investment flows', () => {
  const brokerage: AccountData = {
    id: 'brokerage', type: 'INVESTMENT', balance: 11400, balanceDate: utc(2026, 7, 31),
  };
  const snapshots: SnapshotData[] = [
    { accountId: 'brokerage', date: utc(2026, 6, 30), balance: 10000 },
    { accountId: 'brokerage', date: utc(2026, 7, 31), balance: 11400 },
  ];
  const periods = ['2026-06', '2026-07'];

  // Buying a security turns cash into shares inside the account. Counting it as
  // a flow made one month of trading ($59,552.76 of purchases against a $3,628.42
  // deposit) report a ~$2.5k gain as $25k.
  it('ignores trading and income that never leaves the account', () => {
    const txns = [
      txn({ accountId: 'brokerage', date: utc(2026, 7, 5), amount: -8000, description: 'YOU BOUGHT FIDELITY 500 INDEX FUND' }),
      txn({ accountId: 'brokerage', date: utc(2026, 7, 6), amount: 120, description: 'DIVIDEND RECEIVED FZZAX' }),
      txn({ accountId: 'brokerage', date: utc(2026, 7, 7), amount: -50, description: 'REINVESTMENT FZZAX' }),
    ];
    const july = computeNetWorthGrowth([brokerage], snapshots, txns, periods, 'MONTH').get('2026-07');
    expect(july?.investmentNetFlows).toBe(0);
    expect(july?.marketGains).toBe(1400); // the whole balance change is gain
  });

  // After cash arrives, the feed sweeps it into the core money-market position
  // with a POSITIVE line for the same total. It never crosses the boundary, so
  // it must change neither the flows nor the gain the dividend alone produces.
  it.each([
    'PURCHASE INTO CORE ACCOUNT FIDELITY GOVERNMENT CASH RESERVES (FDRXX) (Cash)',
    'PURCHASE INTO CORE ACCOUNT MORNING TRADE FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)',
  ])('treats the sweep into the core position as internal: %s', (sweep) => {
    const dividend = txn({ accountId: 'brokerage', date: utc(2026, 7, 6), amount: 120, description: 'DIVIDEND RECEIVED FZZAX' });
    const withoutSweep = computeNetWorthGrowth([brokerage], snapshots, [dividend], periods, 'MONTH').get('2026-07');
    const withSweep = computeNetWorthGrowth(
      [brokerage],
      snapshots,
      [dividend, txn({ accountId: 'brokerage', date: utc(2026, 7, 6), amount: 120, description: sweep })],
      periods,
      'MONTH',
    ).get('2026-07');
    expect(withSweep?.investmentNetFlows).toBe(0);
    expect(withSweep?.marketGains).toBe(withoutSweep?.marketGains);
  });

  // The same monthly transfer arrives +1400 from Fidelity's CSV and -1400 from
  // SimpleFIN. The wording is the reliable signal; the sign is not.
  it('takes direction from the wording when a source signs a transfer backwards', () => {
    const txns = [
      txn({ accountId: 'brokerage', date: utc(2026, 7, 1), amount: -1400, description: 'Electronic Funds Transfer Received (Cash)' }),
    ];
    const july = computeNetWorthGrowth([brokerage], snapshots, txns, periods, 'MONTH').get('2026-07');
    expect(july?.investmentNetFlows).toBe(1400);
    expect(july?.marketGains).toBe(0); // balance rose 1400 purely from the deposit
  });

  it('still treats an outbound transfer as money leaving', () => {
    const txns = [
      txn({ accountId: 'brokerage', date: utc(2026, 7, 1), amount: 500, description: 'TRANSFERRED TO BANK — WITHDRAWAL' }),
    ];
    const july = computeNetWorthGrowth([brokerage], snapshots, txns, periods, 'MONTH').get('2026-07');
    expect(july?.investmentNetFlows).toBe(-500);
  });

  // An IRA funded from a brokerage: the brokerage's line names the purpose
  // ("contribution") AND the direction ("Transferred To"). Read by the purpose,
  // both sides counted as money arriving, and the market was charged for it.
  it('lets a stated direction outrank a word naming the purpose', () => {
    const ira: AccountData = { id: 'ira', type: 'INVESTMENT', balance: 4000, balanceDate: utc(2026, 7, 31) };
    const both = [
      ...snapshots,
      { accountId: 'ira', date: utc(2026, 6, 30), balance: 1000 },
      { accountId: 'ira', date: utc(2026, 7, 31), balance: 4000 },
    ];
    const txns = [
      txn({ accountId: 'brokerage', date: utc(2026, 7, 31), amount: -3000, description: 'X00-000000-0PRIOR CONTRIBUTION Transferred To' }),
      txn({ accountId: 'ira', date: utc(2026, 7, 31), amount: 3000, description: 'X00-000001-0 Prior Contribution' }),
    ];
    const july = computeNetWorthGrowth([brokerage, ira], both, txns, periods, 'MONTH').get('2026-07');
    expect(july?.investmentNetFlows).toBe(0); // one account to another: nothing crossed into the total
    expect(july?.marketGains).toBe(4400); // the whole rise, 11,000 to 15,400, is the market's
  });
});

describe('market gains decomposition (buy → appreciate → sell lifecycle)', () => {
  const checking: AccountData = {
    id: 'checking', type: 'DEPOSITORY', balance: 5000, balanceDate: utc(2026, 8, 31),
  };
  const brokerage: AccountData = {
    id: 'brokerage', type: 'INVESTMENT', balance: 10600, balanceDate: utc(2026, 8, 31),
  };
  // June: contribute 5,000 (transfer pair) and buy — account value set by
  // snapshots. July: stock appreciates 600 with NO transaction anywhere.
  // August: sell — still no external movement, value already accrued.
  const snapshots: SnapshotData[] = [
    { accountId: 'brokerage', date: utc(2026, 5, 31), balance: 5000 },
    { accountId: 'brokerage', date: utc(2026, 6, 30), balance: 10000 },
    { accountId: 'brokerage', date: utc(2026, 7, 31), balance: 10600 },
    { accountId: 'brokerage', date: utc(2026, 8, 31), balance: 10600 },
  ];
  const txns = [
    txn({ date: utc(2026, 6, 5), amount: -5000, accountId: 'checking', flow: 'TRANSFER' }),
    txn({ date: utc(2026, 6, 5), amount: 5000, accountId: 'brokerage', flow: 'TRANSFER' }),
    // The buy and the sell inside the brokerage: value-neutral transfers.
    txn({ date: utc(2026, 6, 6), amount: -4800, accountId: 'brokerage', flow: 'TRANSFER' }),
    txn({ date: utc(2026, 6, 6), amount: 4800, accountId: 'brokerage', flow: 'TRANSFER' }),
    txn({ date: utc(2026, 8, 10), amount: -5400, accountId: 'brokerage', flow: 'TRANSFER' }),
    txn({ date: utc(2026, 8, 10), amount: 5400, accountId: 'brokerage', flow: 'TRANSFER' }),
  ];
  const periods = ['2026-05', '2026-06', '2026-07', '2026-08'];
  const result = computeNetWorthGrowth([checking, brokerage], snapshots, txns, periods, 'MONTH');

  it('contribution month: value change fully explained by flows — zero market gain', () => {
    const june = result.get('2026-06');
    expect(june?.investmentNetFlows).toBe(5000);
    expect(june?.marketGains).toBe(0);
  });

  it('appreciation month: +600 with no transactions = pure market gain, and NOT income', () => {
    const july = result.get('2026-07');
    expect(july?.investmentNetFlows).toBe(0);
    expect(july?.marketGains).toBe(600);
    // The same months produce zero income in cash flow — market moves never leak there.
    const flow = computeCashFlowTrend(txns, periods, 'MONTH').get('2026-07');
    expect(flow?.income).toBe(0);
  });

  it('sale month: internal sale moves nothing — gain already accrued, market gain 0', () => {
    const august = result.get('2026-08');
    expect(august?.investmentNetFlows).toBe(0);
    expect(august?.marketGains).toBe(0);
  });

  it('first period in scope has null marketGains (no baseline to compare)', () => {
    expect(result.get('2026-05')?.marketGains).toBeNull();
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
      oneOffIncome: 0,
      oneOffPay: [],
      paychecks: [],
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

  it("records how far the charging account's records reach, over every kind of row", () => {
    const txns = [
      ...monthly([15.99, 15.99, 15.99]),
      // Later rows: an inflow on the same account, and a charge on another.
      txn({ date: utc(2026, 4, 22), amount: 40 }),
      txn({ date: utc(2026, 5, 30), amount: -8, accountId: 'acc2' }),
    ];
    expect(detectRecurringCharges(txns).get('netflix')?.accountThrough).toBe('2026-04-22');
  });

  describe('a plan billed under a renamed descriptor', () => {
    // Invented: a $7.99 monthly plan whose bank descriptor changed twice,
    // with a single charge under the middle name.
    const plan = [
      ...[1, 2, 3, 4].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'pixelvault plus' })),
      txn({ date: utc(2025, 5, 7), amount: -7.99, normalizedMerchant: 'pixelvault httpspixelvault ca' }),
      ...[6, 7, 8, 9, 10].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'pv* pixelvault plus' })),
    ];

    it('follows it into ONE plan, keyed by the newest name, naming the earlier ones', () => {
      const result = detectRecurringCharges(plan);
      expect([...result.keys()]).toEqual(['pv* pixelvault plus']);
      expect(result.get('pv* pixelvault plus')).toMatchObject({
        occurrences: 10,
        cadence: 'MONTHLY',
        lastDate: '2025-10-06',
        aliases: ['pixelvault plus', 'pixelvault httpspixelvault ca'],
      });
    });

    it('keeps two plans that OVERLAP apart, however alike their names', () => {
      const overlapping = [
        ...[1, 2, 3, 4, 5].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'pixelvault plus' })),
        ...[3, 4, 5, 6, 7].map((m) => txn({ date: utc(2025, m, 20), amount: -7.99, normalizedMerchant: 'pixelvault family' })),
      ];
      expect([...detectRecurringCharges(overlapping).keys()].sort()).toEqual(['pixelvault family', 'pixelvault plus']);
    });

    it('keeps them apart on different accounts, at a different price, or with no word in common', () => {
      const before = [1, 2, 3, 4].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'pixelvault plus' }));
      const after = (partial: Partial<TxnData>) =>
        [5, 6, 7, 8].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'pv* pixelvault plus', ...partial }));
      expect(detectRecurringCharges([...before, ...after({ accountId: 'acc2' })]).size).toBe(2);
      expect(detectRecurringCharges([...before, ...after({ amount: -19.99 })]).size).toBe(2);
      expect(detectRecurringCharges([...before, ...after({ normalizedMerchant: 'streamly' })]).size).toBe(2);
    });

    // A plan that stopped and a new one that started months later share a
    // name but not a cadence: the handover has to read like any other cycle.
    it('keeps a pause and a restart apart', () => {
      const paused = [
        ...[1, 2, 3, 4].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'pixelvault plus' })),
        ...[9, 10, 11, 12].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'pv* pixelvault plus' })),
      ];
      expect(detectRecurringCharges(paused).size).toBe(2);
    });

    // Invented, in the shape the audit caught: a gas station and a restaurant
    // in one town, a few months apart at a similar price.
    it('never joins two businesses that only share a town, nor assembles a plan from one-offs', () => {
      const town = [
        txn({ date: utc(2025, 1, 9), amount: -24.1, normalizedMerchant: 'fuelstop palm springs fl' }),
        txn({ date: utc(2025, 4, 11), amount: -26.4, normalizedMerchant: 'fuelstop palm springs fl' }),
        txn({ date: utc(2025, 7, 10), amount: -25.3, normalizedMerchant: 'lotus garden palm springs fl' }),
      ];
      expect(detectRecurringCharges(town).size).toBe(0);
      // Same name, two charges under each spelling: a match, but neither is
      // recurring on its own, so nothing is detected.
      const pieces = [
        ...[1, 2].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'pixelvault plus' })),
        ...[3, 4].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'pv* pixelvault plus' })),
      ];
      expect(detectRecurringCharges(pieces).size).toBe(0);
    });

    it('never joins on a word that only says how the bank billed it', () => {
      const before = [1, 2, 3, 4].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'recurring payment pixelvault' }));
      const after = [5, 6, 7, 8].map((m) => txn({ date: utc(2025, m, 6), amount: -7.99, normalizedMerchant: 'recurring payment streamly' }));
      expect(detectRecurringCharges([...before, ...after]).size).toBe(2);
    });
  });

  it('detects weekly cadence', () => {
    const txns = [1, 8, 15, 22, 29].map((d) =>
      txn({ date: utc(2026, 6, d), amount: -12.5, normalizedMerchant: 'car wash club' }),
    );
    expect(detectRecurringCharges(txns).get('car wash club')?.cadence).toBe('WEEKLY');
  });

  it('leaves rent and taxes out — recurring is not the same as subscribed', () => {
    // Both have the exact shape the detector hunts for: stable descriptor,
    // stable amount, monthly cadence. Neither is something you cancel, and
    // listing them buries the two or three things that are.
    const rent = monthly([2400, 2400, 2400], 'sunset ridge apartments').map((t) => ({
      ...t,
      categoryId: 'cat-rent',
      categoryName: 'Rent & Housing',
    }));
    expect(detectRecurringCharges(rent).size).toBe(0);

    const tax = monthly([500, 500, 500], 'irs usataxpymt').map((t) => ({
      ...t,
      categoryId: 'cat-taxes',
      categoryName: 'Taxes',
    }));
    expect(detectRecurringCharges(tax).size).toBe(0);
  });

  it("demotes a rent portal's convenience fee, which is monthly but is not a plan", () => {
    // Zego bills $7.88 a month: the shape of a subscription, the substance of
    // paying rent. It is caught by its CATEGORY, not by its name, so any rent
    // portal is handled without listing them all.
    const zego = monthly([3.04, 3.04, 3.04], 'zego');
    expect(detectRecurringCharges(zego).get('zego')?.cadence).toBe('MONTHLY');

    const categorized = zego.map((t) => ({ ...t, categoryId: 'cat-rent', categoryName: 'Rent & Housing' }));
    expect(detectRecurringCharges(categorized).size).toBe(0);
  });

  it('still reports an uncategorized recurring charge, which is the common case on first run', () => {
    expect(detectRecurringCharges(monthly([9.99, 9.99, 9.99], 'spotify')).size).toBe(1);
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

describe('reimbursements (fronted dinner, Zelled back)', () => {
  const dining = { categoryId: 'cat-dining', categoryName: 'Dining' };
  const salary = { categoryId: 'cat-salary', categoryName: 'Salary', categoryIsIncome: true };

  it('nets a categorized (unlinked) repayment against the category in its own period', () => {
    const txns = [
      txn({ date: utc(2026, 7, 3), amount: -200, ...dining }), // I paid for dinner
      txn({ date: utc(2026, 7, 5), amount: 150, ...dining, normalizedMerchant: 'zelle from friends' }),
      txn({ date: utc(2026, 7, 1), amount: 5000, ...salary }),
    ];
    const spending = computeSpendingByCategory(txns, ['2026-07'], 'MONTH').get('2026-07');
    expect(spending?.totalSpending).toBe(50);
    expect(spending?.categories.find((c) => c.categoryId === 'cat-dining')?.spending).toBe(50);

    const cashFlow = computeCashFlowTrend(txns, ['2026-07'], 'MONTH').get('2026-07');
    expect(cashFlow?.income).toBe(5000); // repayment is NOT income
    expect(cashFlow?.spending).toBe(50);
    expect(cashFlow?.net).toBe(4950);
  });

  it('attributes a LINKED repayment to the original expense period and category, cross-month', () => {
    const txns = [
      txn({ id: 'dinner', date: utc(2026, 6, 28), amount: -200, ...dining }),
      // Repaid in July, uncategorized, linked to the June dinner:
      txn({ date: utc(2026, 7, 2), amount: 150, reimbursesId: 'dinner', normalizedMerchant: 'zelle from friends' }),
    ];
    const june = computeSpendingByCategory(txns, ['2026-06', '2026-07'], 'MONTH').get('2026-06');
    const july = computeSpendingByCategory(txns, ['2026-06', '2026-07'], 'MONTH').get('2026-07');
    expect(june?.totalSpending).toBe(50); // credit lands where the expense was
    expect(july?.totalSpending).toBe(0);

    const juneFlow = computeCashFlowTrend(txns, ['2026-06', '2026-07'], 'MONTH').get('2026-06');
    const julyFlow = computeCashFlowTrend(txns, ['2026-06', '2026-07'], 'MONTH').get('2026-07');
    expect(juneFlow?.spending).toBe(50);
    expect(julyFlow?.income).toBe(0); // linked repayment is not July income either
  });

  it('a linked repayment overrides its own category, and true income is never netted', () => {
    const txns = [
      txn({ id: 'dinner', date: utc(2026, 7, 3), amount: -200, ...dining }),
      // Mislabeled as Groceries but LINKED to the dinner — link wins:
      txn({ date: utc(2026, 7, 6), amount: 150, categoryId: 'cat-groceries', categoryName: 'Groceries', reimbursesId: 'dinner' }),
      txn({ date: utc(2026, 7, 1), amount: 5000, ...salary }),
      txn({ date: utc(2026, 7, 10), amount: -80, categoryId: 'cat-groceries', categoryName: 'Groceries' }),
    ];
    const spending = computeSpendingByCategory(txns, ['2026-07'], 'MONTH').get('2026-07');
    expect(spending?.categories.find((c) => c.categoryId === 'cat-dining')?.spending).toBe(50);
    expect(spending?.categories.find((c) => c.categoryId === 'cat-groceries')?.spending).toBe(80); // untouched

    const cashFlow = computeCashFlowTrend(txns, ['2026-07'], 'MONTH').get('2026-07');
    expect(cashFlow?.income).toBe(5000); // salary counted once, never netted
  });

  it('refuses a percentage against a month that ended in credit', () => {
    // A category that ended NEGATIVE is not a small base to measure growth
    // from — it is a different sign. Real case: June rent was refunded to
    // −$409.73, and dividing July's $4,655.60 by its magnitude reported
    // "×13.4" as the boldest figure on the page.
    const rent = { categoryId: 'cat-rent', categoryName: 'Rent & Housing' };
    const txns = [
      txn({ id: 'june-rent', date: utc(2026, 6, 1), amount: -200, ...rent }),
      txn({ date: utc(2026, 6, 20), amount: 358, reimbursesId: 'june-rent' }), // refund outran the charge
      txn({ date: utc(2026, 7, 1), amount: -4655.60, ...rent }),
    ];
    const months = computeSpendingByCategory(txns, ['2026-06', '2026-07'], 'MONTH');
    const june = months.get('2026-06')?.categories.find((c) => c.categoryId === 'cat-rent');
    const july = months.get('2026-07')?.categories.find((c) => c.categoryId === 'cat-rent');
    expect(june?.spending).toBe(-158);
    expect(july?.previousSpending).toBe(-158); // the base stays visible…
    expect(july?.deltaPct).toBeNull(); // …but no percentage is claimed from it

    // Same for the month-level totals the cash-flow row prints.
    const flow = computeCashFlowTrend(txns, ['2026-06', '2026-07'], 'MONTH').get('2026-07');
    expect(flow?.previousSpending).toBe(-158);
    expect(flow?.spendingDeltaPct).toBeNull();
  });

  it('over-reimbursement can push a category negative (visible credit, not hidden)', () => {
    const txns = [
      txn({ id: 'dinner', date: utc(2026, 7, 3), amount: -100, ...dining }),
      txn({ date: utc(2026, 7, 5), amount: 150, reimbursesId: 'dinner' }),
    ];
    const spending = computeSpendingByCategory(txns, ['2026-07'], 'MONTH').get('2026-07');
    expect(spending?.categories.find((c) => c.categoryId === 'cat-dining')?.spending).toBe(-50);
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

  // On real data this analyzer emitted six restaurant meals in a single month —
  // 114 of 132 transaction anomalies across 15 months were one category. Every
  // alternative statistic left that composition intact, because it was honest:
  // most outflows were Dining, so the most unusual outflows were too. Reporting
  // only the most unusual one per category is what fixes it.
  it('reports only the most unusual transaction per category', () => {
    const spikes = [
      txn({ id: 'big', date: utc(2026, 7, 8), amount: -900, ...groceries }),
      txn({ id: 'mid', date: utc(2026, 7, 9), amount: -400, ...groceries }),
      txn({ id: 'small', date: utc(2026, 7, 10), amount: -200, ...groceries }),
    ];
    const result = detectTransactionAnomalies([...history, ...spikes], '2026-07', 'MONTH');
    expect(result).toHaveLength(1);
    expect(result[0].transactionId).toBe('big');
  });

  it('still reports one per category when several categories spike', () => {
    const diningHistory = Array.from({ length: 8 }, (_, i) =>
      txn({ id: `d${i}`, date: utc(2026, i + 1 <= 6 ? i + 1 : 6, (i % 27) + 1), amount: -(20 + i), categoryId: 'cat-dining', categoryName: 'Dining' }),
    );
    const result = detectTransactionAnomalies(
      [
        ...history,
        ...diningHistory,
        txn({ id: 'g-spike', date: utc(2026, 7, 8), amount: -900, ...groceries }),
        txn({ id: 'd-spike', date: utc(2026, 7, 9), amount: -400, categoryId: 'cat-dining', categoryName: 'Dining' }),
      ],
      '2026-07',
      'MONTH',
    );
    expect(result.map((r) => r.transactionId).sort()).toEqual(['d-spike', 'g-spike']);
  });

  it('states magnitude as a rank, since a heavy-tailed median is not "typical"', () => {
    const spike = txn({ id: 'spike', date: utc(2026, 7, 8), amount: -900, ...groceries });
    const [result] = detectTransactionAnomalies([...history, spike], '2026-07', 'MONTH');
    // $2332.56 exceeds all 8 historical Groceries amounts ($155.5–$209.93).
    expect(result.percentileOfHistory).toBe(1);
  });

  // A robust z-score assumes ONE population. A category can be two — moving a
  // rent portal's $7.78 fee into Rent & Housing left 12 fees beside 11 rents, and
  // the median of $170.02 described neither, so every rent scored z=36 against a
  // "typical" of $88.95. Rank is distribution-free and cannot be fooled that
  // way, which is also why the UI could already print the refutation:
  // "higher than 67% of your Rent & Housing" is not an anomaly.
  it('does not flag a routine payment in a category that holds two populations', () => {
    const fees = Array.from({ length: 12 }, (_, i) =>
      txn({ id: `fee${i}`, date: utc(2025, (i % 12) + 1, 2), amount: -3.04, categoryId: 'cat-rent', categoryName: 'Rent & Housing' }),
    );
    const rents = Array.from({ length: 11 }, (_, i) =>
      txn({ id: `rent${i}`, date: utc(2025, (i % 11) + 1, 1), amount: -(1750 + i * 8), categoryId: 'cat-rent', categoryName: 'Rent & Housing' }),
    );
    const thisMonth = txn({ id: 'rent-now', date: utc(2026, 7, 1), amount: -1796, categoryId: 'cat-rent', categoryName: 'Rent & Housing' });

    const result = detectTransactionAnomalies([...fees, ...rents, thisMonth], '2026-07', 'MONTH');
    expect(result).toHaveLength(0);

    // The z-score alone still finds it extraordinary — which is precisely why
    // the rank gate has to be the thing that stops it.
    const ungated = detectTransactionAnomalies([...fees, ...rents, thisMonth], '2026-07', 'MONTH', {
      ...DEFAULT_ANOMALY_OPTIONS,
      minPercentile: 0,
    });
    expect(ungated).toHaveLength(1);
    expect(ungated[0].deviation).toBeGreaterThan(10);
  });

  it('still flags a payment that genuinely outruns the rest of its category', () => {
    const fees = Array.from({ length: 12 }, (_, i) =>
      txn({ id: `fee${i}`, date: utc(2025, (i % 12) + 1, 2), amount: -3.04, categoryId: 'cat-rent', categoryName: 'Rent & Housing' }),
    );
    const rents = Array.from({ length: 11 }, (_, i) =>
      txn({ id: `rent${i}`, date: utc(2025, (i % 11) + 1, 1), amount: -(1750 + i * 8), categoryId: 'cat-rent', categoryName: 'Rent & Housing' }),
    );
    const doubled = txn({ id: 'rent-spike', date: utc(2026, 7, 1), amount: -5650, categoryId: 'cat-rent', categoryName: 'Rent & Housing' });

    const result = detectTransactionAnomalies([...fees, ...rents, doubled], '2026-07', 'MONTH');
    expect(result).toHaveLength(1);
    expect(result[0].transactionId).toBe('rent-spike');
  });

  it('leaves the ranking alone — the gate decides eligibility, not the winner', () => {
    const spikes = [
      txn({ id: 'big', date: utc(2026, 7, 8), amount: -900, ...groceries }),
      txn({ id: 'mid', date: utc(2026, 7, 9), amount: -400, ...groceries }),
    ];
    const gated = detectTransactionAnomalies([...history, ...spikes], '2026-07', 'MONTH');
    const ungated = detectTransactionAnomalies([...history, ...spikes], '2026-07', 'MONTH', {
      ...DEFAULT_ANOMALY_OPTIONS,
      minPercentile: 0,
    });
    expect(gated.map((r) => r.transactionId)).toEqual(ungated.map((r) => r.transactionId));
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

describe('P2P payments awaiting confirmation', () => {
  const zelle = { description: 'ZELLE TO JANE DOE ON 07/10', normalizedMerchant: 'zelle to jane doe' };

  it('count toward spending as their own slice, never inside Uncategorized', () => {
    const txns = [
      txn({ date: utc(2026, 7, 10), amount: -300, ...zelle }),
      txn({ date: utc(2026, 7, 11), amount: -50, normalizedMerchant: 'corner cafe', description: 'CORNER CAFE' }),
      txn({ date: utc(2026, 7, 12), amount: -80, ...groceries }),
    ];
    const july = computeSpendingByCategory(txns, ['2026-07'], 'MONTH').get('2026-07')!;
    expect(july.totalSpending).toBe(430);
    expect(july.categories.map((c) => [c.categoryId, c.categoryName, c.spending])).toEqual([
      ['p2p-unreviewed', 'P2P — Unreviewed', 300],
      ['cat-groceries', 'Groceries', 80],
      [null, null, 50],
    ]);
  });

  it('leave the slice the moment a person confirms one', () => {
    const confirmed = txn({ date: utc(2026, 7, 10), amount: -300, ...zelle, categoryId: 'cat-rent', categoryName: 'Rent' });
    const july = computeSpendingByCategory([confirmed], ['2026-07'], 'MONTH').get('2026-07')!;
    expect(july.categories.map((c) => c.categoryId)).toEqual(['cat-rent']);
  });

  it('keep money IN out of spending — unconfirmed inflows are flagged, not counted', () => {
    const incoming = txn({ date: utc(2026, 7, 10), amount: 300, description: 'ZELLE FROM JANE DOE', normalizedMerchant: 'zelle from jane doe' });
    const july = computeSpendingByCategory([incoming], ['2026-07'], 'MONTH').get('2026-07')!;
    expect(july.totalSpending).toBe(0);
    expect(july.categories).toEqual([]);
  });

  it('net a repayment LINKED to one against the same slice its outflow landed in', () => {
    const txns = [
      txn({ id: 'sent', date: utc(2026, 7, 10), amount: -300, ...zelle }),
      txn({ date: utc(2026, 7, 14), amount: 100, reimbursesId: 'sent', description: 'ZELLE FROM JANE DOE', normalizedMerchant: 'zelle from jane doe' }),
    ];
    const july = computeSpendingByCategory(txns, ['2026-07'], 'MONTH').get('2026-07')!;
    expect(july.categories.map((c) => [c.categoryId, c.spending])).toEqual([['p2p-unreviewed', 200]]);
    expect(july.totalSpending).toBe(200);
  });

  it('are never flagged as unusual — their only baseline is the rail, which pools everything', () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      txn({ date: utc(2026, 1 + (i % 6), 5), amount: -40, ...zelle }),
    );
    const big = txn({ date: utc(2026, 7, 10), amount: -1500, ...zelle });
    expect(detectTransactionAnomalies([...history, big], '2026-07', 'MONTH')).toEqual([]);
    // The same payment, once confirmed, is judged against its category again.
    const confirmedHistory = history.map((h) => ({ ...h, categoryId: 'cat-gifts', categoryName: 'Gifts' }));
    const confirmedBig = { ...big, categoryId: 'cat-gifts', categoryName: 'Gifts' };
    expect(detectTransactionAnomalies([...confirmedHistory, confirmedBig], '2026-07', 'MONTH')).toHaveLength(1);
  });
});
