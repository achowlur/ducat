import type { AccountType, NetWorthGrowthPayload, PeriodGranularity } from '../../types/contracts';
import { inPeriod, periodEndExclusive, periodStart, previousPeriodKey } from './periods';
import { round2, round4 } from './stats';
import type { AccountData, SnapshotData, TxnData } from './types';

/**
 * A snapshot at the date convention's noon UTC is a STATEMENT's closing day
 * (pdf/statement.ts noonUtc), a date rather than an instant, already on the
 * day it values. A feed stamps its balance at the bank's own instant, which
 * is never that.
 */
function isStatementDay(d: Date): boolean {
  return d.getUTCHours() === 12 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

/**
 * The feed's snapshots of an aggregator-fed brokerage (`priorClose`), dated
 * to the market day each one values. The feed stamps such a balance at the
 * bank's evening update, which is already the next day in UTC and values
 * the PREVIOUS trading day's close (its Saturday update moved with Friday's
 * market, its Monday update not at all): the update published on the local
 * day D holds the close of D - 1, and is dated the end of D - 1 here, the
 * way the daily line dates it (ui/dailyNetWorth.ts). Read by the UTC
 * instant alone, a month's closing value for such an account was the
 * second-to-last day's close, a trading day behind, unless a statement
 * import had written the month end exactly; now the update published on
 * the first of the next month closes the month, and the month settles with
 * the sync that fetches it. A statement's own snapshot (noon UTC, a day
 * not an instant) is left where it is. `dayOf` is the display zone's
 * calendar day of an instant (lib/displayZone.ts localDayKey).
 */
export function marketDaySnapshots(
  snapshots: SnapshotData[],
  accounts: AccountData[],
  dayOf: (d: Date) => string,
): SnapshotData[] {
  const prior = new Set(accounts.filter((a) => a.priorClose === true).map((a) => a.id));
  if (prior.size === 0) return snapshots;
  return snapshots.map((s) => {
    if (!prior.has(s.accountId) || isStatementDay(s.date)) return s;
    const published = Date.parse(`${dayOf(s.date)}T00:00:00Z`);
    return { ...s, date: new Date(published - 1) };
  });
}

/**
 * Balance of one account at instant `at` (exclusive of transactions after it).
 *
 * Preferred source: the latest BalanceSnapshot at or before `at`, rolled
 * forward with the account's transactions between the snapshot and `at`.
 * Before a cash account's first snapshot, the EARLIEST one after `at` rolled
 * back the same way: a statement's close and the rows that led to it are
 * one record whichever way it is read (a closed account's closing zero and
 * its complete export give every month before it exactly). Only with no
 * snapshot at all does the account's current balance/balanceDate stand in,
 * rolled back through its transactions and flagged `estimated`.
 *
 * `known: false` means the balance is NOT recoverable and callers must not
 * substitute a number. That happens for an INVESTMENT account with no usable
 * snapshot: a brokerage's value moves with the market, and market moves are not
 * transactions, so rolling a balance through trades (every "YOU BOUGHT" is cash
 * leaving with no offsetting entry for what it bought) yields a figure with no
 * relationship to what the account was worth.
 *
 * `investmentSnapshotNotBefore` (callers pass the period start) separates a
 * value that IS the period's from one that stands in for it. With no snapshot
 * inside the period, an investment account is:
 * - ZERO, exactly, when its last snapshot is zero with no transaction since
 *   (a closed account: nothing left for the market to move);
 * - CARRIED, its last earlier snapshot standing in, `estimated` and `carried`
 *   (the operator's choice, 2026-10-15: a month of market movement unseen on
 *   one account is a smaller error than refusing the whole month, PROVIDED
 *   the month says so in text);
 * - otherwise unknown: records that simply start late cannot say what came
 *   before, and the caller names the account instead of guessing.
 * Before an account existed, of ANY type, it is ZERO exactly: its first
 * snapshot is an opening zero (a statement's opening day) and nothing of its
 * own came before it.
 */
export function balanceAt(
  account: AccountData,
  snapshots: SnapshotData[],
  txns: TxnData[],
  at: Date,
  options: { investmentSnapshotNotBefore?: Date } = {},
): { balance: number; estimated: boolean; known: boolean; carried?: true } {
  const marketValued = account.type === 'INVESTMENT';
  const floor = marketValued ? options.investmentSnapshotNotBefore?.getTime() : undefined;
  const own = snapshots
    .filter(
      (s) =>
        s.accountId === account.id &&
        s.date.getTime() <= at.getTime() &&
        (floor === undefined || s.date.getTime() >= floor),
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const mine = snapshots.filter((s) => s.accountId === account.id);
  const ownTxnIn = (from: number, to: number) =>
    txns.some((t) => t.accountId === account.id && t.date.getTime() > from && t.date.getTime() <= to);

  // Not yet open, for ANY account: its first value is an opening zero (a
  // statement's opening day) and nothing of its own came before it. A card
  // opened in 2025 held nothing in 2019, whatever a reconstruction says.
  if (!mine.some((s) => s.date.getTime() <= at.getTime())) {
    const first = mine.reduce<SnapshotData | null>(
      (earliest, s) => (earliest === null || s.date.getTime() < earliest.date.getTime() ? s : earliest),
      null,
    );
    if (first !== null && first.balance === 0 && !ownTxnIn(-Infinity, at.getTime())) {
      return { balance: 0, estimated: false, known: true };
    }
  }

  if (own.length === 0 && marketValued) {
    const last = mine
      .filter((s) => s.date.getTime() <= at.getTime())
      .reduce<SnapshotData | null>((latest, s) => (latest === null || s.date.getTime() > latest.date.getTime() ? s : latest), null);
    if (last !== null) {
      // Closed: nothing for the market to move, while no money has come in since.
      if (last.balance === 0 && !ownTxnIn(last.date.getTime(), at.getTime())) {
        return { balance: 0, estimated: false, known: true };
      }
      // Carried: the last value, plus money that has CROSSED the account since
      // (a deposit is no market movement and is known). Only the market's
      // movement goes unseen, which is what `estimated` says.
      const moved = txns
        .filter((t) => t.accountId === account.id && t.date.getTime() > last.date.getTime() && t.date.getTime() <= at.getTime())
        .reduce((sum, t) => sum + crossingAmount(t), 0);
      return { balance: round2(last.balance + moved), estimated: true, known: true, carried: true };
    }
    return { balance: 0, estimated: true, known: false };
  }

  const later = mine
    .filter((s) => s.date.getTime() > at.getTime())
    .reduce<SnapshotData | null>((earliest, s) => (earliest === null || s.date.getTime() < earliest.date.getTime() ? s : earliest), null);
  const anchor =
    own.length > 0
      ? { balance: own[own.length - 1].balance, date: own[own.length - 1].date, estimated: false }
      : later !== null
        ? { balance: later.balance, date: later.date, estimated: false }
        : { balance: account.balance, date: account.balanceDate, estimated: true };

  // A market-valued snapshot is the account's TOTAL worth, so its own trades
  // must not be applied to it: "YOU BOUGHT VTI -$51,834.59" moves cash into
  // securities inside the same account and leaves the total unchanged, but
  // rolling it forward subtracts the $51,834.59 outright. (SimpleFIN reports
  // trades as plain OUTFLOWs — only the Fidelity CSV mapping flags them
  // TRANSFER — so this is the normal case for a live feed, not an edge one.)
  // The snapshot is reported as-is, flagged estimated whenever it isn't the
  // period-end value it's standing in for.
  if (marketValued) {
    const staleBy = at.getTime() - anchor.date.getTime();
    return { balance: anchor.balance, estimated: staleBy > 3 * 86_400_000, known: true };
  }

  let balance = anchor.balance;
  const lo = Math.min(anchor.date.getTime(), at.getTime());
  const hi = Math.max(anchor.date.getTime(), at.getTime());
  const forward = anchor.date.getTime() <= at.getTime();
  for (const t of txns) {
    if (t.accountId !== account.id) continue;
    const ts = t.date.getTime();
    if (ts <= lo || ts > hi) continue;
    balance += forward ? t.amount : -t.amount;
  }
  return { balance, estimated: anchor.estimated, known: true };
}

/**
 * Activity that stays INSIDE a brokerage account. The definition and its
 * reasoning are on `internalActivity` below, which is this same pattern; it
 * is exported, unchanged, because transfer pairing asks the same question of
 * the same rows (sync/closedBox.ts) and a second copy would drift from it.
 */
export const INTERNAL_INVESTMENT_ACTIVITY =
  /\b(you bought|you sold|reinvest\w*|purchase into core|dividend|interest\b|cap(ital)? gain|advisory fee|in lieu of|redemption|exchange (in|out))\b/i;

/**
 * What one investment-account row moves ACROSS the account's boundary: money
 * in positive, money out negative, and nothing for activity that stays inside.
 * Any balance change not explained by these is market movement.
 *
 * Most activity inside a brokerage moves nothing in or out: buying a security
 * turns cash into shares, a dividend is earned in place, a reinvestment does
 * both. Counting those as flows is badly wrong — one month of trading
 * ($59,552.76 of purchases against a $3,628.42 deposit) turned a real ~$2.5k gain
 * into a reported $64.79k one. Only genuine transfers count.
 *
 * The automatic sweep of arriving cash into the core money-market position
 * ("PURCHASE INTO CORE ACCOUNT") is the same kind of move. SimpleFIN signs it
 * positive, so without the verb it read as a second deposit of the same total.
 *
 * Classification is by exclusion because brokerage verbs are a small stable
 * set while transfer descriptors vary by institution; anything unrecognised
 * counts as a flow, which understates gains rather than inflating them.
 *
 * Direction is taken from the wording when the wording is unambiguous, because
 * sources disagree on the sign. The SAME monthly $3,628.42 transfer, same
 * account and same description, arrives as +1400 from Fidelity's own CSV and
 * -1400 from SimpleFIN. Fidelity's export and the paired debit on the funding
 * account both say it is money IN, so the wording is the reliable signal and
 * only the magnitude is taken from the amount.
 */
const INBOUND_WORDING = /\b(received|transferred from|deposit|contribution|rollover in)\b/i;
const OUTBOUND_WORDING = /\b(withdrawal|transferred to|distribution|rollover out)\b/i;
/**
 * A statement's own direction, which outranks the words naming a transfer's
 * PURPOSE: "PRIOR CONTRIBUTION Transferred To" is money LEAVING one account to
 * fund another's contribution, and read by "contribution" it counted as
 * arriving on both sides, a deposit twice its size the market was then charged
 * for.
 */
const STATED_DIRECTION = /\btransferred (to|from)\b/i;
export function crossingAmount(t: Pick<TxnData, 'amount' | 'description'>): number {
  if (INTERNAL_INVESTMENT_ACTIVITY.test(t.description)) return 0;
  const magnitude = Math.abs(t.amount);
  const stated = STATED_DIRECTION.exec(t.description);
  if (stated !== null) return stated[1].toLowerCase() === "from" ? magnitude : -magnitude;
  return INBOUND_WORDING.test(t.description) ? magnitude : OUTBOUND_WORDING.test(t.description) ? -magnitude : t.amount;
}

/**
 * A row that pays interest or a dividend INTO a bank or investment account:
 * "INTEREST PAYMENT", "DIVIDEND RECEIVED … MONEY MARKET (SPAXX)". Not its
 * reinvestment (the same dollars buying shares), and not a card's interest
 * CHARGE. By wording, as the closed box reads these rows, and by magnitude,
 * since sources sign the same row oppositely.
 */
const EARNED = /\b(interest|dividend)\b/i;
const NOT_EARNED = /\b(reinvest\w*|charge[ds]?|fee)\b/i;
function interestEarned(t: TxnData): number {
  return EARNED.test(t.description) && !NOT_EARNED.test(t.description) ? Math.abs(t.amount) : 0;
}

function sameAccounts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

export function computeNetWorthGrowth(
  accounts: AccountData[],
  snapshots: SnapshotData[],
  txns: TxnData[],
  periods: string[],
  granularity: PeriodGranularity,
): Map<string, NetWorthGrowthPayload> {
  /**
   * The period's net worth over every account whose balance is known for it.
   * An account that is not is LEFT OUT and named (`excluded`), never guessed:
   * a net worth missing an account is a smaller one than the truth, so the
   * payload carries which accounts it leaves out and every screen says so in
   * text. (Until 2026-10-15 such a period was dropped whole, which, once
   * statement history arrived, threw away years of months for one account
   * whose records start late.) Null only when no account is known at all.
   */
  const netWorthAt = (
    key: string,
  ): {
    total: number;
    invTotal: number;
    byType: Partial<Record<AccountType, number>>;
    byAccount: Record<string, number>;
    estimated: string[];
    carried: string[];
    excluded: string[];
  } | null => {
    // "End of period" = last instant before the next period starts.
    const at = new Date(periodEndExclusive(key).getTime() - 1);
    const notBefore = periodStart(key);
    let total = 0;
    let invTotal = 0;
    const byType: Partial<Record<AccountType, number>> = {};
    const byAccount: Record<string, number> = {};
    const estimated: string[] = [];
    const carried: string[] = [];
    const excluded: string[] = [];
    for (const account of accounts) {
      const { balance, estimated: isEstimated, known, carried: isCarried } = balanceAt(account, snapshots, txns, at, {
        investmentSnapshotNotBefore: notBefore,
      });
      if (!known) {
        excluded.push(account.id);
        continue;
      }
      total += balance;
      if (account.type === 'INVESTMENT') invTotal += balance;
      byType[account.type] = round2((byType[account.type] ?? 0) + balance);
      byAccount[account.id] = round2(balance);
      if (isEstimated) estimated.push(account.id);
      if (isCarried === true) carried.push(account.id);
    }
    if (excluded.length === accounts.length) return null;
    return { total: round2(total), invTotal: round2(invTotal), byType, byAccount, estimated, carried, excluded };
  };

  const investmentAccountIds = new Set(accounts.filter((a) => a.type === 'INVESTMENT').map((a) => a.id));
  /**
   * Net money CROSSING each investment account's boundary in the period (see
   * crossingAmount), by account, and in total. By account because the net
   * worth goal counts contributions into INVESTED money only, a line drawn
   * by the operator's cash definition rather than by account type.
   */
  const investmentFlows = (key: string, leftOut: string[]): { total: number; byAccount: Record<string, number> } => {
    let sum = 0;
    const byAccount: Record<string, number> = {};
    for (const t of txns) {
      if (!investmentAccountIds.has(t.accountId) || leftOut.includes(t.accountId) || !inPeriod(t.date, key)) continue;
      const crossing = crossingAmount(t);
      if (crossing === 0) continue;
      sum += crossing;
      byAccount[t.accountId] = round2((byAccount[t.accountId] ?? 0) + crossing);
    }
    return { total: round2(sum), byAccount };
  };

  /**
   * Interest and dividends earned in the period, by bank or investment
   * account: a cash account's yield is measured from these, never from its
   * change in value (net worth goal).
   */
  const earningIds = new Set(accounts.filter((a) => a.type === 'DEPOSITORY' || a.type === 'INVESTMENT').map((a) => a.id));
  const interestBy = (key: string, leftOut: string[]): Record<string, number> => {
    const byAccount: Record<string, number> = {};
    for (const t of txns) {
      if (!earningIds.has(t.accountId) || leftOut.includes(t.accountId) || !inPeriod(t.date, key)) continue;
      const earned = interestEarned(t);
      if (earned > 0) byAccount[t.accountId] = round2((byAccount[t.accountId] ?? 0) + earned);
    }
    return byAccount;
  };

  const result = new Map<string, NetWorthGrowthPayload>();
  for (const key of periods) {
    const current = netWorthAt(key);
    if (current === null) continue;
    const prevKey = previousPeriodKey(key);
    // Only compare when the previous period is also in scope; otherwise we'd
    // report growth against a period with no data behind it.
    const previous = periods.includes(prevKey) ? netWorthAt(prevKey) : null;
    // Two months over different accounts are not one net worth moving: an
    // account entering the sum is not growth, and its value is not a gain.
    const comparable = previous !== null && sameAccounts(previous.excluded, current.excluded);
    const growthRate =
      comparable && previous.total !== 0 ? round4((current.total - previous.total) / Math.abs(previous.total)) : null;
    const flows = investmentFlows(key, current.excluded);
    const marketGains = comparable ? round2(current.invTotal - previous.invTotal - flows.total) : null;
    result.set(key, {
      granularity,
      netWorth: current.total,
      previousNetWorth: previous === null ? null : previous.total,
      growthRate,
      byAccountType: current.byType,
      byAccount: current.byAccount,
      marketGains,
      investmentNetFlows: flows.total,
      investmentFlowsByAccount: flows.byAccount,
      interestByAccount: interestBy(key, current.excluded),
      estimatedAccountIds: current.estimated,
      carriedAccountIds: current.carried,
      excludedAccountIds: current.excluded,
    });
  }
  return result;
}
