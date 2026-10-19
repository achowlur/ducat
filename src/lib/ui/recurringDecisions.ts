import { refuse, type Refusal } from "../actionResult";
import {
  isActive,
  mergeDetectedSubscriptions,
  missedCharge,
  type DetectedCharge,
  type DetectedSubscription,
} from "../health/detectedSubscriptions";
import { priceNow } from "../insights/recurring";

/**
 * What the operator decided about a recurring plan from an alert on /insights
 * (ActionAlert): kept a price rise, said a plan is still active, or said it was
 * cancelled, or that a shared plan's unsplit bill was not shared that month.
 * One Setting, no schema change.
 *
 * Every decision names the plan by EVERY merchant string it was folded from
 * (mergeDetectedSubscriptions), because the same service reaches the detector
 * under several: a decision that named only the surviving name would stop
 * reaching the plan the day a sibling string became the shortest.
 */
export const RECURRING_DECISIONS_KEY = "recurring.decisions";

/** Decisions kept per kind; the oldest fall away, as pay.newPay keeps its last few. */
const KEPT = 40;

export interface PlanDecision {
  /** The plan's merchant strings, lowercased. */
  names: string[];
  /** The plan's last charge when it was decided: a later charge ends the answer. */
  lastDate: string;
  /** keep: the price the rise was kept at, "17.99". */
  price?: string;
  /** unshared: the day of the bill that was not shared ("2026-09-04"). */
  bill?: string;
}

export interface Decisions {
  keep: PlanDecision[];
  still: PlanDecision[];
  cancelled: PlanDecision[];
  /** "Not shared this month": that bill counts in full and is not asked about again. */
  unshared: PlanDecision[];
}

export const NO_DECISIONS: Decisions = { keep: [], still: [], cancelled: [], unshared: [] };

export type Choice = "keep" | "still" | "cancel" | "unshared";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseList(raw: unknown): PlanDecision[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanDecision[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const { names, lastDate, price, bill } = item as Record<string, unknown>;
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string") || names.length === 0) continue;
    if (typeof lastDate !== "string" || !ISO_DAY.test(lastDate)) continue;
    out.push({
      names: names as string[],
      lastDate,
      ...(typeof price === "string" ? { price } : {}),
      ...(typeof bill === "string" && ISO_DAY.test(bill) ? { bill } : {}),
    });
  }
  return out;
}

/** The stored Setting value; anything unreadable is no decisions, never a failure. */
export function parseDecisions(raw: string | null): Decisions {
  if (raw === null) return NO_DECISIONS;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      keep: parseList(value.keep),
      still: parseList(value.still),
      cancelled: parseList(value.cancelled),
      unshared: parseList(value.unshared),
    };
  } catch {
    return NO_DECISIONS;
  }
}

const membersOf = (c: { merchant: string; members?: string[] }): string[] =>
  c.members ?? [c.merchant.trim().toLowerCase()];

const reaches = (d: PlanDecision, c: { merchant: string; members?: string[] }): boolean =>
  membersOf(c).some((m) => d.names.includes(m));

/** What a plan bills now, as the decision records it. */
const priceId = (c: DetectedCharge): string => priceNow(c).toFixed(2);

/**
 * Cancelled: no charge newer than the one it was cancelled at. A charge that
 * lands afterwards means the plan is billing after all, so it is back.
 */
export function isCancelled(c: DetectedCharge & { members?: string[] }, d: Decisions): boolean {
  return d.cancelled.some((x) => reaches(x, c) && c.lastDate <= x.lastDate);
}

/** A rise the operator kept: hidden until the plan's price changes again. */
export function riseKept(c: DetectedCharge & { members?: string[] }, d: Decisions): boolean {
  return d.keep.some((x) => reaches(x, c) && x.price === priceId(c));
}

/**
 * The billing date a plan missed, unless the operator answered "still active"
 * for it. The answer covers that last charge only: a newer charge ends it, so
 * the next miss asks again. The next expected charge passing uncharged is the
 * detector's own lapse (two cycles, isActive), which moves the plan under "No
 * longer charging" and out of the alerts and the totals, so the answer needs
 * no date of its own.
 */
export function missedNews(c: DetectedCharge & { members?: string[] }, d: Decisions, asOf: Date): Date | null {
  const missed = missedCharge(c, asOf);
  if (missed === null) return null;
  return d.still.some((x) => reaches(x, c) && x.lastDate === c.lastDate) ? null : missed;
}

/**
 * A shared plan's unsplit bill (RecurringChargePayload.shared.unsplit), unless
 * the operator said that bill was not shared. The answer names the BILL, so the
 * next one to go unsplit asks again; two in a row end the sharing in the
 * detector itself (insights/sharedPlans.ts), with nothing left to ask.
 */
export function notSplitNews(
  c: DetectedCharge & { members?: string[] },
  d: Decisions,
): { date: string; amount: number; repaid: number } | null {
  const unsplit = c.shared?.unsplit ?? null;
  if (unsplit === null) return null;
  return d.unshared.some((x) => reaches(x, c) && x.bill === unsplit.date) ? null : unsplit;
}

/**
 * The plans still counting: this month's charges without the cancelled and
 * lapsed ones, merged as the totals merge them. The page and the action read
 * the same list, so a button can only act on what the page showed.
 */
export function livePlans(charges: DetectedCharge[], d: Decisions, asOf: Date): DetectedSubscription[] {
  return mergeDetectedSubscriptions(charges).filter((p) => isActive(p, asOf) && !isCancelled(p, d));
}

function remember(list: PlanDecision[], next: PlanDecision): PlanDecision[] {
  const rest = list.filter((x) => !x.names.some((n) => next.names.includes(n)));
  return [...rest, next].slice(-KEPT);
}

/**
 * Apply one choice to one plan, or refuse in a sentence for the control. A
 * choice never touches a transaction: it only writes what to show and count.
 */
export function decide(
  choice: Choice,
  plan: string,
  plans: DetectedSubscription[],
  d: Decisions,
  now: Date,
): { ok: true; decisions: Decisions } | Refusal {
  const wanted = plan.trim().toLowerCase();
  const sub = plans.find((p) => membersOf(p).includes(wanted));
  if (sub === undefined) return refuse("That plan is no longer on the list. Reload the page to see what is current.");
  const names = membersOf(sub);
  const base = { names, lastDate: sub.lastDate };
  switch (choice) {
    case "keep":
      if (!sub.priceIncreased || riseKept(sub, d)) return refuse("That price rise is no longer news, so there is nothing to keep.");
      return { ok: true, decisions: { ...d, keep: remember(d.keep, { ...base, price: priceId(sub) }) } };
    case "still":
      if (missedNews(sub, d, now) === null) return refuse("That plan is not missing a charge, so there is nothing to answer.");
      return { ok: true, decisions: { ...d, still: remember(d.still, base) } };
    case "cancel":
      return { ok: true, decisions: { ...d, cancelled: remember(d.cancelled, base) } };
    case "unshared": {
      const unsplit = notSplitNews(sub, d);
      if (unsplit === null) return refuse("That bill is no longer waiting to be split, so there is nothing to answer.");
      return { ok: true, decisions: { ...d, unshared: remember(d.unshared, { ...base, bill: unsplit.date }) } };
    }
  }
}
