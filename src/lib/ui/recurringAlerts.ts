import { annualisedTotal, nextChargeOf, type DetectedCharge, type DetectedSubscription } from "../health/detectedSubscriptions";
import { priceNow } from "../insights/recurring";
import { livePlans, missedNews, notSplitNews, riseKept, type Choice, type Decisions } from "./recurringDecisions";
import { money, shortDate, shortDateYear, titleCase } from "./format";

/** How many alerts are in view; any more fold behind a tap. */
export const ALERTS_IN_VIEW = 2;

export interface RecurringAlert {
  /** Stable across renders: the plan and what the alert is about. */
  id: string;
  /** The plan's surviving merchant string, which the actions take back. */
  plan: string;
  kind: "Price up" | "Not charging" | "Not split";
  /** The sentence. */
  text: string;
  /** The faint line under it. */
  detail: string;
  /** The two controls, in order: a label and the choice it saves, or the page it opens. */
  actions: ({ label: string; choice: Choice } | { label: string; href: string })[];
  /** What the plan costs a year: the order the alerts rank by. */
  stake: number;
  /** Days to the next charge, for a price rise; null for a missed charge, which has none due. */
  daysAway: number | null;
  /** The plan's last charge ("2026-10-03"): a newer one is new data about it. */
  lastDate: string;
  /** Not split: the day of the bill it is about. */
  bill?: string;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** A shared plan's cost in words: "your share ~$37 of $110". */
export function yourShare(share: number, full: number): string {
  return `your share ~${dollars.format(share)} of ${dollars.format(full)}`;
}

/**
 * Where an unsplit bill's repayments get linked: the money that came in from
 * the bill's month through the next (repayments arrive days later, often
 * across a month end), where each row's link picker ranks the bill by amount.
 */
export function linkRepaymentsHref(billDate: string): string {
  const [y, m] = billDate.split("-").map(Number);
  const next = new Date(Date.UTC(y, m, 1));
  const to = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  return `/transactions?flow=INFLOW&period=${billDate.slice(0, 7)}..${to}`;
}

function renews(days: number, date: Date): string {
  if (days === 0) return "Renews today";
  if (days === 1) return "Renews in 1 day";
  return days <= 45 ? `Renews in ${days} days` : `Renews ${shortDate(date)}`;
}

/**
 * The alerts for the plans still counting: a price rise that is still news, a
 * charge that went missing and a shared plan's bill nobody repaid, each unless
 * the operator already answered it.
 * Ranked by what the plan costs a year, the first two in view and the rest
 * folded. Empty is the usual answer, and every consumer survives it.
 */
export function recurringAlerts(
  plans: DetectedSubscription[],
  d: Decisions,
  now: Date,
): { shown: RecurringAlert[]; folded: RecurringAlert[] } {
  const all: RecurringAlert[] = [];
  for (const plan of plans) {
    const name = titleCase(plan.merchant);
    const stake = annualisedTotal([plan]);
    const missed = missedNews(plan, d, now);
    if (missed !== null) {
      const last = new Date(`${plan.lastDate}T12:00:00Z`);
      const sameYear = last.getUTCFullYear() === now.getUTCFullYear();
      all.push({
        id: `missed|${plan.merchant}|${plan.lastDate}`,
        plan: plan.merchant,
        kind: "Not charging",
        text: `${name} has not charged since ${MONTH_NAMES[last.getUTCMonth()]}${sameYear ? "" : ` ${last.getUTCFullYear()}`}`,
        detail: `Last charge ${sameYear ? shortDate(last) : shortDateYear(last)}`,
        actions: [
          { label: "Still active", choice: "still" },
          { label: "Cancelled", choice: "cancel" },
        ],
        stake,
        daysAway: null,
        lastDate: plan.lastDate,
      });
    } else if (plan.priceIncreased && !riseKept(plan, d)) {
      const was = plan.previousAverageAmount ?? null;
      const now$ = priceNow(plan);
      const percent = was !== null && was > 0 ? Math.round(((now$ - was) / was) * 100) : null;
      const next = nextChargeOf(plan, now);
      all.push({
        id: `rise|${plan.merchant}|${now$.toFixed(2)}`,
        plan: plan.merchant,
        kind: "Price up",
        text: `${name} rose ${percent !== null && percent >= 1 ? `${percent}% ` : ""}to ${money(now$)}`,
        detail: renews(next.daysAway, next.date),
        actions: [
          { label: "Keep", choice: "keep" },
          { label: "Cancelled", choice: "cancel" },
        ],
        stake,
        daysAway: next.daysAway,
        lastDate: plan.lastDate,
      });
    }
    // A shared plan's bill that the next one found still unsplit: it counts at
    // the bill less what WAS repaid until the rest is linked or the operator
    // says it was not shared (a missed plan has a bigger question to answer).
    const unsplit = missed === null ? notSplitNews(plan, d) : null;
    if (unsplit !== null && plan.shared !== undefined) {
      const bill = new Date(`${unsplit.date}T12:00:00Z`);
      // Literally true: SPENDING counts the bill less what was repaid; the
      // subscription figures keep billing the share.
      const counted = Math.round((unsplit.amount - unsplit.repaid) * 100) / 100;
      const month = MONTH_NAMES[bill.getUTCMonth()];
      const share = yourShare(plan.shared.share, priceNow(plan));
      all.push({
        id: `unsplit|${plan.merchant}|${unsplit.date}`,
        plan: plan.merchant,
        kind: "Not split",
        text: unsplit.repaid > 0 ? `${name}'s ${month} bill is only part split` : `${name}'s ${month} bill hasn't been split yet`,
        detail:
          unsplit.repaid > 0
            ? `Spending counts ${money(counted)} of it until the rest is linked · ${share}`
            : `Spending counts it in full until the repayments are linked · ${share}`,
        actions: [
          { label: "Link repayments", href: linkRepaymentsHref(unsplit.date) },
          { label: "Not shared this month", choice: "unshared" },
        ],
        stake,
        daysAway: null,
        lastDate: plan.lastDate,
        bill: unsplit.date,
      });
    }
  }
  all.sort((a, b) => b.stake - a.stake || (a.id < b.id ? -1 : 1));
  return { shown: all.slice(0, ALERTS_IN_VIEW), folded: all.slice(ALERTS_IN_VIEW) };
}

/**
 * The alerts for a month's recurring rows, as Recurring charges opens with
 * them: the live plans (cancelled and lapsed ones out, merged as the totals
 * merge them) as of `asOf`, judged at `now`. Overview's "Do this next" reads
 * the same list, so the two pages cannot disagree on what is news.
 */
export function recurringAlertsFor(
  charges: DetectedCharge[],
  d: Decisions,
  asOf: Date,
  now: Date,
): { shown: RecurringAlert[]; folded: RecurringAlert[] } {
  return recurringAlerts(livePlans(charges, d, asOf), d, now);
}
