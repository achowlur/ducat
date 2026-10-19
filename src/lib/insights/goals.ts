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
  /** The house price the target was derived from, kept as a DECLARED
   * aspiration for display — the percentages that derived it are not kept
   * and nothing re-runs the arithmetic at render. */
  housePrice?: number;
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
  /**
   * Dollars saved a month, SET by the operator in place of the measured pace
   * (the "Saved per month" field on the card; the net worth goal's
   * monthlyPace, same rule). Optional and additive: an entry without it, which
   * is every entry written before 2026-10-19, follows the data exactly as
   * before, and a reader that predates it ignores it. Absent means follow the
   * measured pace; a value typed equal to the measured one is never stored.
   */
  monthlyPace?: number;
}

/** The largest monthly pace a save accepts: past it a projection is noise (the net worth goal's bound). */
export const MAX_GOAL_PACE = 1e9;

const validPace = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_GOAL_PACE;

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
  /**
   * Cash goals only: what the cards owe, as positive dollars, already taken
   * off `saved`. 0 for a nominated fund, or with nothing owed.
   */
  cardsOwed: number;
  /** target − saved; negative once the goal is overshot. */
  remaining: number;
  /** saved / target clamped to [0, 1], for a progress figure. */
  progress: number;
  /** saved ≥ target. A reached goal needs no rate and refuses nothing. */
  reached: boolean;
  /**
   * The pace the landing is projected at: the operator's `monthlyPace` when
   * one is set, else the measured mean. Present whenever the basis suffices.
   */
  monthlyRate: number | null;
  /** The measured mean monthly net over the window, whatever is set; null while the basis is too short. */
  measuredRate: number | null;
  /** The pace the operator set, or null while the card follows the data. */
  paceSet: number | null;
  /** The instant the landing was projected from (ms), so the browser re-projects from the same one. */
  nowMs: number;
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
  /**
   * Cash goals only: the fund's OBSERVED mean monthly growth over the same
   * window the rate averages — the reconciliation the projection owes. The
   * rate assumes every saved dollar stays in cash; a standing transfer out
   * (to investments here) makes the landing optimistic, and with a single
   * goal nothing else on the panel states that assumption. Null for
   * nominated goals: their funds can hold investment accounts, whose
   * balances transactions cannot explain.
   */
  observedFundGrowth: number | null;
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
    (g.housePrice === undefined || (typeof g.housePrice === 'number' && Number.isFinite(g.housePrice) && g.housePrice > 0)) &&
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
    if (!Array.isArray(parsed)) return [];
    // An unreadable pace is ignored, never a reason to drop the whole goal.
    return parsed.filter(isGoal).map((g) => {
      if (g.monthlyPace === undefined || validPace(g.monthlyPace)) return g;
      const rest = { ...g };
      delete rest.monthlyPace;
      return rest;
    });
  } catch {
    return []; // a corrupted setting must not take the page down
  }
}

/**
 * Where a fund lands: the months it takes to close `remaining` at `rate`, and
 * the month that falls in. The ONE arithmetic behind a goal's date, run by
 * assessGoals on the server and by the card in the browser as the pace is
 * typed, so the two cannot disagree. Null at a pace at or below zero.
 */
export function projectLanding(
  remaining: number,
  rate: number,
  nowMs: number,
): { monthsToTarget: number; landsMonth: string } | null {
  if (!(rate > 0) || !(remaining > 0)) return null;
  const monthsToTarget = remaining / rate;
  return {
    monthsToTarget: Math.round(monthsToTarget * 10) / 10,
    landsMonth: periodKey(new Date(nowMs + monthsToTarget * MONTH_MS), 'MONTH'),
  };
}

/** landsMonth − targetMonth in months: negative = ahead, positive = behind. Null without a declared month. */
export function monthsAfterTarget(landsMonth: string, targetMonth: string | undefined): number | null {
  return targetMonth === undefined ? null : monthIndex(landsMonth) - monthIndex(targetMonth);
}

/** The extra a month is rounded UP to, so the figure printed really does land on time. */
export const SHORTFALL_STEP = 10;

/**
 * What a goal projected to land AFTER its target month asks for: the pace that
 * lands in that month (`required`) and the `extra` a month over `rate` it
 * takes, rounded up to $10. It inverts projectLanding, whose landing month is
 * the one `now + remaining/rate` falls in, so it lands on time when it comes
 * before the first instant of the month after the target.
 *
 * Null when there is nothing to ask: no target month, no pace to build on
 * (zero or below), nothing left to save, already on time, or a target month
 * already over or under way with less than a month left (no pace fixes that).
 */
export function extraToLand(input: {
  remaining: number;
  rate: number | null;
  targetMonth: string | undefined;
  nowMs: number;
}): { required: number; extra: number } | null {
  const { remaining, rate, targetMonth, nowMs } = input;
  if (targetMonth === undefined || rate === null || !(rate > 0) || !(remaining > 0)) return null;
  const landing = projectLanding(remaining, rate, nowMs);
  if (landing === null) return null;
  const behind = monthsAfterTarget(landing.landsMonth, targetMonth);
  if (behind === null || behind <= 0) return null;
  const ends = Date.UTC(Number(targetMonth.slice(0, 4)), Number(targetMonth.slice(5, 7)), 1);
  const available = (ends - nowMs) / MONTH_MS;
  // Under a month left no saving rate is a believable ask: the month is as good as over.
  if (!(available >= 1)) return null;
  const required = remaining / available;
  const extra = Math.ceil((required - rate) / SHORTFALL_STEP) * SHORTFALL_STEP;
  return extra > 0 ? { required: round2(required), extra } : null;
}

/**
 * The stored goals with one goal's set pace changed or cleared (null), as the
 * text to write back, or why not. Works on the raw entries so every other
 * field of every entry, a malformed one or one from a newer shape included,
 * is written back exactly as it was read.
 */
export function withGoalPace(
  raw: string | null,
  id: string,
  pace: number | null,
): { ok: true; value: string } | { ok: false; message: string } {
  if (pace !== null && !validPace(pace)) return { ok: false, message: 'The monthly saving has to be a dollar amount.' };
  let entries: unknown;
  try {
    entries = raw === null ? null : JSON.parse(raw);
  } catch {
    entries = null;
  }
  if (!Array.isArray(entries)) return { ok: false, message: 'The savings goals could not be read, so nothing was saved.' };
  let found = false;
  const next = entries.map((e: unknown) => {
    if (typeof e !== 'object' || e === null || (e as Record<string, unknown>).id !== id) return e;
    found = true;
    const rest = { ...(e as Record<string, unknown>) };
    delete rest.monthlyPace;
    return pace === null ? rest : { ...rest, monthlyPace: round2(pace) };
  });
  if (!found) return { ok: false, message: 'That goal is no longer declared.' };
  return { ok: true, value: JSON.stringify(next) };
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
  /** The cards, whose balances (negative while owed) a CASH goal counts
   * against its fund: the cash pays them, so it is cash after cards. */
  cards?: readonly GoalAccount[];
  /** Observed mean monthly growth of the cash fund over the rate's window,
   * computed by the caller from cash-account transactions. */
  observedCashGrowth?: number | null;
  completeMonthlyNet: readonly number[];
  now: Date;
}): GoalAssessment[] {
  const { goals, accounts, cashAccounts = [], cards = [], observedCashGrowth = null, completeMonthlyNet, now } = input;
  const onCards = round2(cards.reduce((s, a) => s + a.balance, 0));
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
    // A cash fund is cash AFTER the cards it pays.
    const cardsOwed = goal.cash === true ? Math.max(0, -onCards) : 0;
    const saved = round2(held.reduce((s, a) => s + a.balance, 0) + (goal.cash === true ? onCards : 0));

    const base = {
      goal,
      saved,
      accountNames: held.map((a) => a.name),
      // A cash goal nominates a DEFINITION, not ids — nothing can go missing.
      missingAccounts: goal.cash === true ? 0 : goal.accountIds.length - held.length,
      cardsOwed,
      remaining: round2(goal.target - saved),
      progress: Math.min(1, Math.max(0, saved / goal.target)),
      reached: false,
      monthlyRate: null as number | null,
      measuredRate: mean === null ? null : round2(mean),
      paceSet: goal.monthlyPace ?? null,
      nowMs: now.getTime(),
      basisMonths,
      rateLow: null as number | null,
      rateHigh: null as number | null,
      monthsToTarget: null as number | null,
      landsMonth: null as string | null,
      deltaMonths: null as number | null,
      observedFundGrowth:
        goal.cash === true && observedCashGrowth !== null ? round2(observedCashGrowth) : null,
      refusal: null as GoalRefusal | null,
    };

    // A fund with no accounts behind it is broken config, not $0 saved.
    if (held.length === 0) return { ...base, saved: 0, remaining: round2(goal.target), progress: 0, refusal: 'NO_ACCOUNTS' as const };

    // Reached is a fact, checked before any rate question: a reached goal with
    // a bad month behind it is still reached.
    if (saved >= goal.target) return { ...base, reached: true };

    if (mean === null) return { ...base, refusal: 'TOO_FEW_MONTHS' as const };

    // A pace the operator set stands in for the measured one; the window's
    // low and high stay the measured months, which is what they describe.
    const pace = goal.monthlyPace ?? mean;
    const rate = {
      monthlyRate: round2(pace),
      rateLow: round2(Math.min(...recent)),
      rateHigh: round2(Math.max(...recent)),
    };

    // The rate is observed and survives the refusal — "net −$803.44/mo" is the
    // reason there is no date, and the reader should see it.
    const landing = projectLanding(goal.target - saved, pace, now.getTime());
    if (landing === null) return { ...base, ...rate, refusal: 'RATE_NOT_POSITIVE' as const };

    return {
      ...base,
      ...rate,
      monthsToTarget: landing.monthsToTarget,
      landsMonth: landing.landsMonth,
      // No declared month means no ahead/behind — the projection stands alone.
      deltaMonths: monthsAfterTarget(landing.landsMonth, goal.targetMonth),
    };
  });
}
