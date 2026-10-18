/**
 * What you can actually spend, what you owe, and how long the first covers the
 * second — the three balance questions Overview left the reader to do in their
 * head.
 *
 * "Counts as cash" is deliberately NOT the account type. A brokerage account
 * can hold a money-market balance that is spendable tomorrow, and one here does
 * exactly that: it grows about $142.55 a month with no transaction behind it, which
 * is interest. Retyping it DEPOSITORY would be the obvious move and it is
 * wrong — cash and credit are exempt from the snapshot rule in netWorth.ts
 * BECAUSE transactions fully explain them, and this account's do not. It would
 * start being reconstructed from transactions and net worth would drift.
 *
 * So liquidity and market-valuation are two different questions about one
 * account, and the override answers only the first. It lives in `Setting`
 * rather than a column because it is per-instance operator config, the same
 * shape as the last-sync marker, and because a schema change has to be applied
 * by hand to the cloud database.
 */
import type { PrismaClient } from '../../generated/prisma/client';

export const CASH_ACCOUNTS_KEY = 'cash.additionalAccountIds';

/** Account types whose balance is spendable without selling anything. */
const CASH_TYPES = new Set(['DEPOSITORY']);

/** Types that represent money owed rather than money held. */
const DEBT_TYPES = new Set(['CREDIT', 'LOAN']);

export interface BalanceLike {
  id: string;
  type: string;
  balance: number;
}

export interface BalanceSummary {
  cash: number;
  investments: number;
  /** Signed, so it stays negative like the balances it sums. */
  debt: number;
  cashAccounts: number;
  /**
   * Counted in the SAME branch that sums `investments`, and exported for that
   * reason. Overview derived it separately as `!isCash && balance >= 0`, which
   * is a different partition wearing the same name: it swept in the two credit
   * cards sitting at 0.00 and printed "13 accounts" under a figure that summed
   * three, so the band's own three notes described ten accounts for eight rows.
   * A positive (over-paid) card and a LOAN at zero were the same bug waiting.
   */
  investmentAccounts: number;
  debtAccounts: number;
  /** The LOANs among debtAccounts; the rest are cards. */
  loanAccounts: number;
  /**
   * The cards' balances alone, signed like `debt` (loans left out). What
   * cash has to cover soon: the runway and a cash goal count cash AFTER it,
   * since a card balance is paid from the very cash they would count.
   */
  cards: number;
}

/**
 * The note under Owed. It said "2 cards" for a card and an auto loan: every
 * debt account was a "card". Named apart, and a kind with none is left out.
 */
export function debtNote(debtAccounts: number, loanAccounts: number): string {
  const cards = debtAccounts - loanAccounts;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [cards > 0 ? plural(cards, 'card') : null, loanAccounts > 0 ? plural(loanAccounts, 'loan') : null]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

export async function readCashAccountIds(prisma: PrismaClient): Promise<string[]> {
  const row = await prisma.setting.findUnique({ where: { key: CASH_ACCOUNTS_KEY } });
  if (row === null) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return []; // a corrupted setting must not take the page down
  }
}

export function countsAsCash(account: BalanceLike, extraIds: readonly string[]): boolean {
  return CASH_TYPES.has(account.type) || extraIds.includes(account.id);
}

export function summariseBalances(
  accounts: readonly BalanceLike[],
  extraIds: readonly string[] = [],
): BalanceSummary {
  let cash = 0;
  let investments = 0;
  let debt = 0;
  let cashAccounts = 0;
  let investmentAccounts = 0;
  let debtAccounts = 0;
  let loanAccounts = 0;
  let cards = 0;
  for (const a of accounts) {
    if (countsAsCash(a, extraIds)) {
      cash += a.balance;
      cashAccounts += 1;
    } else if (DEBT_TYPES.has(a.type)) {
      debt += a.balance;
      debtAccounts += 1;
      if (a.type === 'LOAN') loanAccounts += 1;
      else cards += a.balance;
    } else {
      investments += a.balance;
      investmentAccounts += 1;
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    cash: round(cash),
    investments: round(investments),
    debt: round(debt),
    cashAccounts,
    investmentAccounts,
    debtAccounts,
    loanAccounts,
    cards: round(cards),
  };
}

/**
 * Complete months to average spending over, and the fewest that will do.
 * Exported because the savings-goal rate (insights/goals.ts) averages the same
 * window — two notions of "recent complete months" on one app would drift, and
 * a test pins them equal.
 */
export const RUNWAY_MONTHS = 6;
export const RUNWAY_MIN_MONTHS = 3;

export interface Runway {
  months: number;
  /** A typical month's spending the figure divides by: the middle of the months. */
  monthlySpending: number;
  /** How many complete months it is drawn from. */
  basisMonths: number;
  /** Lowest and highest of those months: the middle hides how variable they are. */
  low: number;
  high: number;
}

/**
 * Months of cash at a typical month's spending. The caller passes the cash
 * AFTER open card balances (they are paid from it) and each month's EVERYDAY
 * spending (SpendingByCategoryPayload.everydayAfterDay[0]: the app's own
 * spending figure, travel and one-off purchases left out), never a second
 * summation of outflows, which would also swallow investment trades.
 *
 * The MIDDLE of the months, never their mean. A mean of every month's total
 * counted each trip and one-off purchase as a monthly habit, and the everyday
 * series can still read one month far off (a payment the anomaly pass called
 * a one-off with its refund left in), which a mean takes a sixth of and the
 * middle ignores, as the pace call and the idle-cash buffer already do.
 *
 * Refuses rather than guessing when there is too little history, when a
 * typical month nets to zero or below, or when there is no cash to divide.
 */
export function computeRunway(
  cash: number,
  completeMonthlySpending: readonly number[],
): Runway | null {
  const recent = completeMonthlySpending.slice(-RUNWAY_MONTHS);
  if (recent.length < RUNWAY_MIN_MONTHS) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const typical = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  if (typical <= 0 || cash <= 0) return null;
  return {
    months: Math.round((cash / typical) * 10) / 10,
    monthlySpending: Math.round(typical * 100) / 100,
    basisMonths: recent.length,
    low: Math.round(sorted[0] * 100) / 100,
    high: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}
