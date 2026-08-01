import { periodKey } from './periods';
import { round2 } from './stats';

/**
 * Savings goals: a declared target with a horizon — "House deposit, $155,503.76 by
 * Jun 2028" — shown against the observed savings rate. The app cannot infer a
 * deposit target, so declaring one adds information the data does not contain;
 * that is the test a goal passes and a per-category budget fails.
 *
 * Two different measures meet here, on purpose:
 *
 * - SAVED is the summed balance of the accounts the goal NOMINATES. Cash as a
 *   whole would breathe by a rent cycle every month and count the emergency
 *   fund toward the house; net worth would drag market movement and the
 *   snapshot machinery in, so a red week reads as un-saving. Which balances
 *   are the fund is exactly the thing only the operator can say.
 * - The RATE is the app-wide net from CASH_FLOW_TREND, averaged over the same
 *   window `computeRunway` uses (a test pins the two windows equal). Transfers
 *   are excluded from cash flow, so moving money INTO a nominated account
 *   cannot inflate the rate that projects it. The projection therefore assumes
 *   future net savings reach the fund — the panel says so, and chips the date
 *   PROJECTED like every other forecast.
 *
 * Declarations live in the `Setting` key below, not a table, for the reason
 * recorded in ui/liquidity.ts: per-instance operator config, and a Setting
 * reaches the cloud database without hand-applied schema surgery. Written by
 * `npm run goals`; a corrupted value must not take the page down, so parsing
 * is tolerant the way `readCashAccountIds` is.
 *
 * Refusals mirror `computeRunway`: too few complete months, or a rate at or
 * below zero, and it says so rather than printing a fantasy date. The facts
 * either side of the projection (saved, target, the negative rate itself)
 * survive every refusal, the same contract `computePace` keeps.
 */

export const SAVINGS_GOALS_KEY = 'goals.savings';

/**
 * The rate window: same numbers as RUNWAY_MONTHS / RUNWAY_MIN_MONTHS in
 * ui/liquidity.ts. Not imported from there because insights/ sits below ui/
 * and layers depend downward only — goals.test.ts asserts the values match.
 */
export const GOAL_RATE_MONTHS = 6;
export const GOAL_RATE_MIN_MONTHS = 3;

/** Mean Gregorian month, for turning a fractional month count into a date. */
const MONTH_MS = 30.4375 * 86_400_000;

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface SavingsGoal {
  /** Stable slug, derived from the name at declaration ("house-deposit"). */
  id: string;
  name: string;
  /** Positive dollars. */
  target: number;
  /**
   * Month key "2028-06" — the aspiration to compare the projection against.
   * OPTIONAL since 2026-08-01: the landing date is always projected from the
   * observed rate, and an operator who wants only what the data says declares
   * no month at all — then there is no ahead/behind, just the landing.
   */
  targetMonth?: string;
  /**
   * True means the fund is CASH ON HAND — whatever the operator's cash
   * definition resolves to at render (DEPOSITORY accounts plus
   * `cash.additionalAccountIds`), passed in as `cashAccounts`. Added
   * 2026-08-01, reversing the nominated-only design with evidence: the
   * operator's savings observably accumulate ACROSS cash (checking took the
   * monthly residual while the nominated fund received nothing after its
   * one-time seeding), so a single nominated account systematically
   * understated saved. The costs the original design named — cash breathes by
   * a rent cycle, and the emergency fund counts toward the house — were
   * accepted by the operator with eyes open. `accountIds` is ignored when set.
   */
  cash?: boolean;
  /** Nominated accounts whose balances count as this goal's fund. */
  accountIds: string[];
}

export interface GoalAccount {
  id: string;
  name: string;
  balance: number;
}

export type GoalRefusal = 'NO_ACCOUNTS' | 'TOO_FEW_MONTHS' | 'RATE_NOT_POSITIVE';

export interface GoalAssessment {
  goal: SavingsGoal;
  /** Sum of the nominated balances that resolved. */
  saved: number;
  /** Names of the nominated accounts that resolved, declaration order. */
  accountNames: string[];
  /** Nominated ids no longer matching an account — `saved` is understated when > 0. */
  missingAccounts: number;
  /** target − saved; negative once the goal is overshot. */
  remaining: number;
  /** saved / target clamped to [0, 1], for a progress figure. */
  progress: number;
  /** saved ≥ target. A reached goal needs no rate and refuses nothing. */
  reached: boolean;
  /** Mean monthly net over the window; present whenever the basis suffices. */
  monthlyRate: number | null;
  /** Complete months the mean is drawn from (0–GOAL_RATE_MONTHS). */
  basisMonths: number;
  /** Lowest and highest month in the window — a mean hides how variable it is. */
  rateLow: number | null;
  rateHigh: number | null;
  /** remaining / rate, to one decimal; null under any refusal or when reached. */
  monthsToTarget: number | null;
  /** Month key the target lands in at the current rate. */
  landsMonth: string | null;
  /** landsMonth − targetMonth in months: negative = ahead, positive = behind. */
  deltaMonths: number | null;
  refusal: GoalRefusal | null;
}

/** "2028-06" → 24341, so two month keys subtract into a month count. */
function monthIndex(key: string): number {
  return Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1);
}

function isGoal(v: unknown): v is SavingsGoal {
  if (typeof v !== 'object' || v === null) return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g.id === 'string' &&
    g.id.length > 0 &&
    typeof g.name === 'string' &&
    g.name.length > 0 &&
    typeof g.target === 'number' &&
    Number.isFinite(g.target) &&
    g.target > 0 &&
    (g.targetMonth === undefined || (typeof g.targetMonth === 'string' && MONTH_KEY.test(g.targetMonth))) &&
    (g.cash === undefined || typeof g.cash === 'boolean') &&
    Array.isArray(g.accountIds) &&
    g.accountIds.every((id) => typeof id === 'string')
  );
}

/** The stored Setting value → declarations, dropping anything malformed. */
export function parseGoals(raw: string | null): SavingsGoal[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isGoal) : [];
  } catch {
    return []; // a corrupted setting must not take the page down
  }
}

/**
 * @param completeMonthlyNet Net (income − spending) of COMPLETE months only,
 *   oldest first — the caller cuts the partial current month, the same way
 *   Overview feeds `computeRunway`.
 */
export function assessGoals(input: {
  goals: SavingsGoal[];
  accounts: GoalAccount[];
  /** The operator's cash definition, resolved by the caller — the fund of any
   * `cash: true` goal. Resolved at render, never frozen at declaration, so
   * "whatever counts as cash" stays whatever the operator last declared. */
  cashAccounts?: readonly GoalAccount[];
  completeMonthlyNet: readonly number[];
  now: Date;
}): GoalAssessment[] {
  const { goals, accounts, cashAccounts = [], completeMonthlyNet, now } = input;
  const byId = new Map(accounts.map((a) => [a.id, a]));

  // One rate for every goal: it is the operator's savings rate, not a goal's.
  const recent = completeMonthlyNet.slice(-GOAL_RATE_MONTHS);
  const basisMonths = recent.length;
  const mean =
    basisMonths >= GOAL_RATE_MIN_MONTHS
      ? recent.reduce((s, n) => s + n, 0) / basisMonths
      : null;

  return goals.map((goal) => {
    const held =
      goal.cash === true
        ? [...cashAccounts]
        : goal.accountIds.map((id) => byId.get(id)).filter((a): a is GoalAccount => a !== undefined);
    const saved = round2(held.reduce((s, a) => s + a.balance, 0));

    const base = {
      goal,
      saved,
      accountNames: held.map((a) => a.name),
      // A cash goal nominates a DEFINITION, not ids — nothing can go missing.
      missingAccounts: goal.cash === true ? 0 : goal.accountIds.length - held.length,
      remaining: round2(goal.target - saved),
      progress: Math.min(1, Math.max(0, saved / goal.target)),
      reached: false,
      monthlyRate: null as number | null,
      basisMonths,
      rateLow: null as number | null,
      rateHigh: null as number | null,
      monthsToTarget: null as number | null,
      landsMonth: null as string | null,
      deltaMonths: null as number | null,
      refusal: null as GoalRefusal | null,
    };

    // A fund with no accounts behind it is broken config, not $0 saved.
    if (held.length === 0) return { ...base, saved: 0, remaining: round2(goal.target), progress: 0, refusal: 'NO_ACCOUNTS' as const };

    // Reached is a fact, checked before any rate question: a reached goal with
    // a bad month behind it is still reached.
    if (saved >= goal.target) return { ...base, reached: true };

    if (mean === null) return { ...base, refusal: 'TOO_FEW_MONTHS' as const };

    const rate = {
      monthlyRate: round2(mean),
      rateLow: round2(Math.min(...recent)),
      rateHigh: round2(Math.max(...recent)),
    };

    // The rate is observed and survives the refusal — "net −$803.44/mo" is the
    // reason there is no date, and the reader should see it.
    if (mean <= 0) return { ...base, ...rate, refusal: 'RATE_NOT_POSITIVE' as const };

    const monthsToTarget = (goal.target - saved) / mean;
    const landsMonth = periodKey(new Date(now.getTime() + monthsToTarget * MONTH_MS), 'MONTH');
    return {
      ...base,
      ...rate,
      monthsToTarget: Math.round(monthsToTarget * 10) / 10,
      landsMonth,
      // No declared month means no ahead/behind — the projection stands alone.
      deltaMonths: goal.targetMonth === undefined ? null : monthIndex(landsMonth) - monthIndex(goal.targetMonth),
    };
  });
}
