import type { SpendingByCategoryPayload } from "../../types/contracts";
import { NOT_EVERYDAY_CATEGORIES } from "../insights/spendingByCategory";
import { periodEndExclusive, periodKey, periodStart } from "../insights/periods";
import { recentMonths, type RecentMonths } from "../insights/recentMonths";
import { median } from "../insights/stats";

/**
 * The budget (/budget): a limit per category, suggested from the category's
 * own recent months and changed only where the operator types one.
 *
 * A category is budgeted MONTHLY or YEARLY. Monthly ones add up to the
 * headline, what is left to spend this month; yearly ones are funds for
 * spending that comes in bulk (travel, gifts), measured over the calendar
 * year, so a trip in March never turns March red if it fits the year. They
 * reach the headline only as the plan line's monthly set-aside.
 *
 * Every figure is the analyzers' own (SpendingByCategoryPayload, TRANSFER
 * out, reimbursements netted), never a second summation of transactions.
 */

/** Setting holding the operator's choices, keyed by categoryKey. */
export const BUDGET_KEY = "budget.categories";

/** The key for spending with no category. */
export const NO_CATEGORY_KEY = "none";

/** Below this many months with a day-by-day record, the pace is a straight line through the month. */
export const PACE_MIN_MONTHS = 3;

/** Ahead of pace means past it by more than this share of the limit, and at least AHEAD_MIN dollars. */
export const AHEAD_SHARE = 0.1;
export const AHEAD_MIN = 10;

/** Months in the yearly window (as the runway's lumpy spending: LUMPY_MONTHS). */
export const YEARLY_WINDOW = 12;

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Whole dollars, true minus: a budget is read at a glance, never to the cent. */
export function dollars(n: number): string {
  return `${n < 0 ? "−" : ""}$${whole.format(Math.abs(Math.round(n)))}`;
}

export interface BudgetChoice {
  /** The operator's limit, monthly or yearly by `yearly`; absent follows the suggestion. */
  limit?: number;
  /** Absent follows the default (yearlyByDefault). */
  yearly?: boolean;
}

export type BudgetChoices = Record<string, BudgetChoice>;

export function categoryKey(categoryId: string | null): string {
  return categoryId ?? NO_CATEGORY_KEY;
}

/** Reads the Setting; anything unreadable is ignored, never a failed page. */
export function parseBudget(raw: string | null): BudgetChoices {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: BudgetChoices = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const choice: BudgetChoice = {};
    if (typeof v.limit === "number" && Number.isFinite(v.limit) && v.limit >= 0) choice.limit = v.limit;
    if (typeof v.yearly === "boolean") choice.yearly = v.yearly;
    if (choice.limit !== undefined || choice.yearly !== undefined) out[key] = choice;
  }
  return out;
}

export type BudgetEdit =
  | { kind: "limit"; key: string; limit: number | null }
  | { kind: "yearly"; key: string; yearly: boolean; yearlyByDefault: boolean };

/**
 * One edit applied. A null limit follows the suggestion again. Switching
 * between monthly and yearly drops a typed limit, which was in the other
 * unit; switching back to the default stores nothing.
 */
export function withBudgetEdit(choices: BudgetChoices, edit: BudgetEdit): { ok: true; choices: BudgetChoices } | { ok: false; message: string } {
  if (edit.key === "") return { ok: false, message: "That category could not be read." };
  const next: BudgetChoices = { ...choices };
  const current: BudgetChoice = { ...(next[edit.key] ?? {}) };
  if (edit.kind === "limit") {
    if (edit.limit !== null && (!Number.isFinite(edit.limit) || edit.limit < 0)) {
      return { ok: false, message: "A limit is a dollar amount of zero or more." };
    }
    if (edit.limit === null) delete current.limit;
    else current.limit = Math.round(edit.limit * 100) / 100;
  } else {
    delete current.limit;
    if (edit.yearly === edit.yearlyByDefault) delete current.yearly;
    else current.yearly = edit.yearly;
  }
  if (current.limit === undefined && current.yearly === undefined) delete next[edit.key];
  else next[edit.key] = current;
  return { ok: true, choices: next };
}

export type BudgetStatus = "over" | "ahead" | "on-pace";

export interface BudgetLine {
  key: string;
  name: string;
  yearly: boolean;
  yearlyByDefault: boolean;
  /** The limit in force: the operator's, else the suggestion. */
  limit: number;
  suggested: number;
  typed: boolean;
  /** This month's spending (monthly) or this calendar year's (yearly). */
  spent: number;
  /** This month's spending, for a yearly line's context. */
  spentThisMonth: number;
  /** What the limit allows by today at this category's usual timing (yearly: a straight line through the year). */
  expectedByToday: number;
  /** True when the timing is the category's own; false: a straight line through the period. */
  paceFromHistory: boolean;
  status: BudgetStatus;
  /** Set on the one line standing for the categories past MAX_MONTHLY_LINES: their names. Not editable. */
  folded?: string[];
}

/** The monthly table names this many budgets, the largest limits; the rest fold into one Other line. */
export const MAX_MONTHLY_LINES = 10;

/** The key of the folded line. */
export const OTHER_KEY = "__other";

/**
 * The largest MAX_MONTHLY_LINES budgets by limit, and the rest as ONE line
 * that adds them up, so every figure the headline sums is still on screen. A
 * category new this month has no history and a $0 limit, so it lands here
 * rather than reading as over a limit nobody set.
 */
export function foldMonthly(lines: BudgetLine[]): BudgetLine[] {
  if (lines.length <= MAX_MONTHLY_LINES) return lines;
  const kept = lines.slice(0, MAX_MONTHLY_LINES - 1);
  const rest = lines.slice(MAX_MONTHLY_LINES - 1);
  const sum = (f: (l: BudgetLine) => number) => round2(rest.reduce((s, l) => s + f(l), 0));
  const limit = sum((l) => l.limit);
  const spent = sum((l) => l.spent);
  const expectedByToday = sum((l) => l.expectedByToday);
  return [
    ...kept,
    {
      key: OTHER_KEY,
      name: `Other · ${rest.length}`,
      yearly: false,
      yearlyByDefault: false,
      limit,
      suggested: limit,
      typed: false,
      spent,
      spentThisMonth: spent,
      expectedByToday,
      paceFromHistory: rest.every((l) => l.paceFromHistory),
      status: statusOf(spent, limit, expectedByToday, false),
      folded: rest.map((l) => l.name),
    },
  ];
}

export interface Budget {
  period: string;
  /** Today's UTC day of the month, and how many days are left including it. */
  day: number;
  daysInMonth: number;
  daysLeft: number;
  monthly: BudgetLine[];
  yearly: BudgetLine[];
  monthlyLimit: number;
  monthlySpent: number;
  /** Monthly limits less monthly spending: below zero is over. */
  left: number;
  /** What `left` allows a day for the days left; null when nothing is left. */
  perDay: number | null;
  /** The yearly funds' limits, a twelfth each. */
  yearlySetAside: number;
  /** A typical month's regular income, when the caller has one. */
  income: number | null;
  /** Income less monthly limits and the yearly set-aside; null without income. */
  toSave: number | null;
  /** The months monthly limits are suggested from. */
  window: RecentMonths;
  /** The months yearly limits are suggested from. */
  yearlyWindow: RecentMonths;
}

interface MonthRow {
  period: string;
  payload: SpendingByCategoryPayload;
}

const ceilTo = (n: number, step: number) => (n <= 0 ? 0 : Math.ceil(n / step) * step);
const round2 = (n: number) => Math.round(n * 100) / 100;

function spendingOf(row: MonthRow | undefined, key: string): number {
  return row?.payload.categories.find((c) => categoryKey(c.categoryId) === key)?.spending ?? 0;
}

/**
 * The share of a month's spending a category has usually done by `day`: the
 * MIDDLE of its recent months' shares (as the pace call takes the middle of
 * its months), each month's spending through that day over its whole. A
 * category that pays rent on the 1st has done all of it by the 2nd; groceries
 * about half by the 15th. Months the category spent nothing in, or that were
 * stored before the day-by-day record, tell nothing and are skipped.
 */
export function typicalShare(rows: readonly MonthRow[], key: string, day: number): number | null {
  const shares: number[] = [];
  for (const row of rows) {
    const c = row.payload.categories.find((x) => categoryKey(x.categoryId) === key);
    if (c === undefined || c.byDay === undefined || c.spending <= 0) continue;
    const through = c.byDay.reduce((sum, [d, v]) => (d <= day ? sum + v : sum), 0);
    shares.push(Math.min(1, Math.max(0, through / c.spending)));
  }
  return shares.length < PACE_MIN_MONTHS ? null : median(shares);
}

function statusOf(spent: number, limit: number, expected: number, yearly: boolean): BudgetStatus {
  if (spent > limit + 0.005) return "over";
  if (!yearly && spent > expected + Math.max(AHEAD_MIN, limit * AHEAD_SHARE)) return "ahead";
  return "on-pace";
}

export function buildBudget(input: {
  now: Date;
  /** SPENDING_BY_CATEGORY month rows, the month being lived in among them. */
  months: readonly MonthRow[];
  /** Where each account's records begin: which months are comparable (recentMonths). */
  firstTransactions: readonly (Date | null)[];
  choices: BudgetChoices;
  income: number | null;
}): Budget {
  const { now, choices } = input;
  const period = periodKey(now, "MONTH");
  const byPeriod = new Map(input.months.map((m) => [m.period, m]));
  const complete = input.months.map((m) => m.period).filter((p) => p < period).sort();
  const window = recentMonths(complete, input.firstTransactions);
  const yearlyWindow = recentMonths(complete, input.firstTransactions, YEARLY_WINDOW);
  const windowRows = window.used.map((p) => byPeriod.get(p)!);
  const yearlyRows = yearlyWindow.used.map((p) => byPeriod.get(p)!);
  const current = byPeriod.get(period);
  const year = period.slice(0, 4);
  const yearRows = input.months.filter((m) => m.period.startsWith(year) && m.period <= period);

  const day = now.getUTCDate();
  const daysInMonth = Math.round((periodEndExclusive(period).getTime() - periodStart(period).getTime()) / 86_400_000);
  const daysLeft = daysInMonth - day + 1;
  const yearStart = Date.UTC(now.getUTCFullYear(), 0, 1);
  const yearFraction = (now.getTime() - yearStart) / (Date.UTC(now.getUTCFullYear() + 1, 0, 1) - yearStart);

  // Every category spent in over the yearly window or this month, by its newest name.
  const names = new Map<string, string>();
  for (const row of [...yearlyRows, ...(current ? [current] : [])]) {
    for (const c of row.payload.categories) names.set(categoryKey(c.categoryId), c.categoryName ?? "Uncategorized");
  }

  const monthly: BudgetLine[] = [];
  const yearly: BudgetLine[] = [];
  for (const [key, name] of names) {
    const activeMonths = yearlyRows.filter((r) => spendingOf(r, key) > 0).length;
    // Bulk spending by nature (travel), or a category spent in at most a
    // third of a long enough record: a monthly limit for it would read empty
    // most months and blown in the others.
    const yearlyByDefault =
      NOT_EVERYDAY_CATEGORIES.has(name) ||
      (yearlyRows.length >= 6 && activeMonths > 0 && activeMonths <= yearlyRows.length / 3);
    const isYearly = choices[key]?.yearly ?? yearlyByDefault;
    const spentThisMonth = round2(spendingOf(current, key));
    let suggested: number;
    let spent: number;
    let expectedByToday: number;
    let paceFromHistory: boolean;
    const typed = choices[key]?.limit;
    if (isYearly) {
      const total = yearlyRows.reduce((sum, r) => sum + spendingOf(r, key), 0);
      suggested = yearlyRows.length === 0 ? 0 : ceilTo((total / yearlyRows.length) * 12, 50);
      spent = round2(yearRows.reduce((sum, r) => sum + spendingOf(r, key), 0));
      const limit = typed ?? suggested;
      expectedByToday = round2(limit * yearFraction);
      paceFromHistory = false;
    } else {
      suggested = windowRows.length === 0 ? 0 : ceilTo(median(windowRows.map((r) => spendingOf(r, key))), 10);
      spent = spentThisMonth;
      const limit = typed ?? suggested;
      const share = typicalShare(windowRows, key, day);
      paceFromHistory = share !== null;
      expectedByToday = round2(limit * (share ?? day / daysInMonth));
    }
    const limit = typed ?? suggested;
    // Nothing to budget and nothing spent: a category that has gone quiet.
    if (limit === 0 && spent <= 0 && typed === undefined) continue;
    const line: BudgetLine = {
      key,
      name,
      yearly: isYearly,
      yearlyByDefault,
      limit,
      suggested,
      typed: typed !== undefined,
      spent,
      spentThisMonth,
      expectedByToday,
      paceFromHistory,
      status: statusOf(spent, limit, expectedByToday, isYearly),
    };
    (isYearly ? yearly : monthly).push(line);
  }
  const byLimit = (a: BudgetLine, b: BudgetLine) => b.limit - a.limit || b.spent - a.spent || a.name.localeCompare(b.name);
  monthly.sort(byLimit);
  yearly.sort(byLimit);

  const monthlyLimit = round2(monthly.reduce((sum, l) => sum + l.limit, 0));
  const monthlySpent = round2(monthly.reduce((sum, l) => sum + l.spent, 0));
  const left = round2(monthlyLimit - monthlySpent);
  const yearlySetAside = round2(yearly.reduce((sum, l) => sum + l.limit, 0) / 12);
  return {
    period,
    day,
    daysInMonth,
    daysLeft,
    monthly: foldMonthly(monthly),
    yearly,
    monthlyLimit,
    monthlySpent,
    left,
    perDay: left > 0 ? round2(left / daysLeft) : null,
    yearlySetAside,
    income: input.income,
    toSave: input.income === null ? null : round2(input.income - monthlyLimit - yearlySetAside),
    window,
    yearlyWindow,
  };
}
