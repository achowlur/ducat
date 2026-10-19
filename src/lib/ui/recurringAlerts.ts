import { annualisedTotal, nextChargeOf, type DetectedSubscription } from "../health/detectedSubscriptions";
import { priceNow } from "../insights/recurring";
import { missedNews, riseKept, type Choice, type Decisions } from "./recurringDecisions";
import { money, shortDate, shortDateYear, titleCase } from "./format";

/** How many alerts are in view; any more fold behind a tap. */
export const ALERTS_IN_VIEW = 2;

export interface RecurringAlert {
  /** Stable across renders: the plan and what the alert is about. */
  id: string;
  /** The plan's surviving merchant string, which the actions take back. */
  plan: string;
  kind: "Price up" | "Not charging";
  /** The sentence. */
  text: string;
  /** The faint line under it. */
  detail: string;
  /** The two buttons, in order, as a label and the choice it makes. */
  actions: { label: string; choice: Choice }[];
  /** What the plan costs a year: the order the alerts rank by. */
  stake: number;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function renews(days: number, date: Date): string {
  if (days === 0) return "Renews today";
  if (days === 1) return "Renews in 1 day";
  return days <= 45 ? `Renews in ${days} days` : `Renews ${shortDate(date)}`;
}

/**
 * The alerts for the plans still counting: a price rise that is still news and
 * a charge that went missing, each unless the operator already answered it.
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
      });
    }
  }
  all.sort((a, b) => b.stake - a.stake || (a.id < b.id ? -1 : 1));
  return { shown: all.slice(0, ALERTS_IN_VIEW), folded: all.slice(ALERTS_IN_VIEW) };
}
