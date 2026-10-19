import { refuse, type Refusal } from "../actionResult";
import { shortfallOf, type GoalAssessment } from "../insights/goals";
import { periodEndExclusive } from "../insights/periods";
import { monthLabel, titleCase } from "./format";
import { ASSUMED_INFLATION_PCT, keepingUpOf, type NetWorthGoalAssessment } from "./netWorthGoal";
import type { RecurringAlert } from "./recurringAlerts";
import type { StaleAction } from "./staleAction";

/**
 * Overview's "Do this next": the ONE most urgent thing the rest of the app
 * already asks for, with the next two after it. Every candidate comes from the
 * code that computes it for its own page (the net worth goal's idle-cash and
 * keeping-up lines, a savings goal's BEHIND, Recurring charges' alerts, the
 * stale alert, the review items); nothing here measures anything.
 *
 * Ducat never moves money, so no sentence here says it will: each one names
 * what the reader can do.
 */
export type NudgeKind = "recurring" | "goal" | "idle" | "keepUp" | "uncategorized" | "p2p" | "stale";

export interface Nudge {
  /** Stable while the nudge is about the same thing: what Mark done records. */
  key: string;
  kind: NudgeKind;
  /** The sentence the slot leads with. */
  text: string;
  /** A few words for the "Then:" line. */
  short: string;
  /** Where the figure is explained: the Details link. */
  href: string;
  /**
   * The newest data the nudge stands on (ms): an account's balance date, a
   * plan's last charge, the newest row imported, the month-end a goal is
   * projected from. Mark done hides the nudge until this passes the click.
   */
  asOf: number;
  /** Order within its kind, lower first. */
  order: number;
}

/** A recurring decision counts as a deadline when its charge lands within this many days. */
export const DUE_WITHIN_DAYS = 7;

/**
 * The ranking, as one table, because it is the whole decision:
 *
 * 1. A DEADLINE or MONEY AT RISK: a price rise renewing within a week (the
 *    charge lands whether or not anyone looks), then a savings goal set to
 *    land after its target month (every month left makes the ask larger).
 * 2. IDLE MONEY: cash beyond a month of spending earning nothing, then a
 *    monthly deposit that has fallen behind inflation. Both cost a little
 *    every month, and nothing is lost by doing them next week.
 * 3. TIDYING: uncategorized rows, then P2P payments, then a stale feed: the
 *    order and the reason of the Needs review panel, where uncategorized rows
 *    understate every spending total while a stale balance is merely old.
 */
const RANK: Record<NudgeKind, number> = {
  recurring: 0,
  goal: 1,
  idle: 2,
  keepUp: 3,
  uncategorized: 4,
  p2p: 5,
  stale: 6,
};

export function rankNudges(nudges: readonly Nudge[]): Nudge[] {
  return [...nudges].sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/** The Setting Mark done writes: one `{key, at}` per nudge marked done. */
export const NUDGES_DONE_KEY = "nudges.done";

/** Entries kept; the oldest fall away. */
const KEPT = 40;

export interface DoneEntry {
  key: string;
  /** When Mark done was pressed, ISO. */
  at: string;
}

/** The stored Setting; anything unreadable is nothing marked done, never a failure. */
export function parseDone(raw: string | null): DoneEntry[] {
  if (raw === null) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (e): e is DoneEntry =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as DoneEntry).key === "string" &&
        typeof (e as DoneEntry).at === "string" &&
        Number.isFinite(Date.parse((e as DoneEntry).at)),
    );
  } catch {
    return [];
  }
}

/**
 * Hidden while nothing NEWER than the click has arrived for what the nudge is
 * about. For an account it is the balance's own date passing the click, not
 * merely the next sync: SimpleFIN balances lag a day or two, and a sync that
 * brings yesterday's balance would show the nudge again before the money
 * moved. Once newer data is in, the nudge is whatever the data says: still
 * true, it is a candidate and shows; resolved, it is no candidate at all.
 */
export function isHidden(n: Nudge, done: readonly DoneEntry[]): boolean {
  return done.some((d) => d.key === n.key && n.asOf <= Date.parse(d.at));
}

export interface NextAction {
  lead: Nudge | null;
  /** The next ones after the lead, at most two. */
  then: Nudge[];
  /** Candidates marked done and waiting on newer data. */
  waiting: number;
}

export function nextAction(candidates: readonly Nudge[], done: readonly DoneEntry[]): NextAction {
  const ranked = rankNudges(candidates);
  const shown = ranked.filter((n) => !isHidden(n, done));
  return { lead: shown[0] ?? null, then: shown.slice(1, 3), waiting: ranked.length - shown.length };
}

/**
 * Mark done for one nudge, or refuse in a sentence. Refused when the nudge is
 * not on the list the page would show now (a stale page). Every other entry is
 * kept only while it still hides a current candidate: one whose data has
 * arrived has been re-evaluated, and one with no candidate was resolved, so
 * both are dropped.
 */
export function markDone(
  done: readonly DoneEntry[],
  key: string,
  at: Date,
  candidates: readonly Nudge[],
): { ok: true; done: DoneEntry[] } | Refusal {
  const target = candidates.find((n) => n.key === key);
  if (target === undefined || isHidden(target, done)) {
    return refuse("That is no longer the next thing to do. Reload the page to see what is current.");
  }
  const kept = done.filter((d) => d.key !== key && candidates.some((n) => n.key === d.key && isHidden(n, [d])));
  return { ok: true, done: [...kept, { key, at: at.toISOString() }].slice(-KEPT) };
}

const roughly = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const newest = (dates: readonly (Date | null | undefined)[]) =>
  Math.max(0, ...dates.filter((d): d is Date => d instanceof Date).map((d) => d.getTime()));

export interface NudgeSources {
  /** Recurring charges' alerts, shown and folded alike. */
  recurring: readonly RecurringAlert[];
  savingsGoals: readonly GoalAssessment[];
  netWorthGoal: NetWorthGoalAssessment | null;
  stale: StaleAction | null;
  uncategorized: { count: number; newestImport: Date | null };
  p2p: { count: number; newestImport: Date | null };
  /** Each account's balance date, by id and by name (the stale alert names accounts). */
  accounts: readonly { id: string; name: string; balanceDate: Date }[];
  /** A savings goal's fund: its account ids (a cash goal resolves the cash definition). */
  fundIds: (goal: GoalAssessment) => readonly string[];
}

/** Every candidate the app asks for today, unranked. Empty is the usual answer. */
export function nudgeCandidates(s: NudgeSources): Nudge[] {
  const dateOf = (ids: readonly string[]) => newest(s.accounts.filter((a) => ids.includes(a.id)).map((a) => a.balanceDate));
  const out: Nudge[] = [];

  for (const a of s.recurring) {
    if (a.kind !== "Price up" || a.daysAway === null || a.daysAway > DUE_WITHIN_DAYS) continue;
    const name = titleCase(a.plan);
    const when = a.daysAway === 0 ? "today" : a.daysAway === 1 ? "tomorrow" : `in ${a.daysAway} days`;
    out.push({
      key: `recurring:${a.id}`,
      kind: "recurring",
      text: `${a.text} and renews ${when}`,
      short: `${name} renews ${when}`,
      href: "/insights#recurring-charges",
      asOf: Date.parse(`${a.lastDate}T12:00:00Z`),
      order: a.daysAway,
    });
  }

  for (const g of s.savingsGoals) {
    const short = shortfallOf(g, g.paceSet);
    if (short === null || g.goal.targetMonth === undefined) continue;
    out.push({
      key: `goal:${g.goal.id}`,
      kind: "goal",
      text: `Save ~${roughly.format(short.extra)}/mo more for ${g.goal.name} to land by ${monthLabel(g.goal.targetMonth)}`,
      short: `${g.goal.name} behind`,
      href: `/insights#goal-${g.goal.id}`,
      asOf: dateOf(s.fundIds(g)),
      order: -short.extra,
    });
  }

  const nw = s.netWorthGoal;
  if (nw !== null && nw.idle !== null && !nw.reached) {
    const idle = nw.idle;
    out.push({
      key: "idle-cash",
      kind: "idle",
      text: `${roughly.format(idle.idle)} in ${idle.from.join(" + ")} earns nothing past a month of spending; in ${idle.to.name} it would earn ~${roughly.format(idle.yearly)}/yr`,
      short: "idle cash",
      href: "/insights#net-worth-goal",
      asOf: dateOf(idle.fromIds),
      order: -idle.yearly,
    });
  }
  const keeping = nw === null ? null : keepingUpOf(nw, nw.goal.monthlyInvest ?? null);
  if (nw !== null && keeping !== null && keeping.behind && nw.anchor !== null && nw.contribution !== null) {
    out.push({
      key: "keep-up",
      kind: "keepUp",
      text: `Invest ~${roughly.format(keeping.needed)}/mo, not ${roughly.format(nw.contribution)}, to keep up with ${ASSUMED_INFLATION_PCT}% inflation`,
      short: "investing vs inflation",
      href: "/insights#net-worth-goal",
      // The deposit is measured from complete month-ends: the next one is the new data.
      asOf: periodEndExclusive(nw.anchor).getTime(),
      order: 0,
    });
  }

  if (s.uncategorized.count > 0) {
    out.push({
      key: "uncategorized",
      kind: "uncategorized",
      text: `Categorize ${plural(s.uncategorized.count, "transaction", "transactions")}: spending totals are incomplete until then`,
      short: `${s.uncategorized.count} to categorize`,
      href: "/transactions?category=uncategorized&payees=1",
      asOf: newest([s.uncategorized.newestImport]),
      order: 0,
    });
  }
  if (s.p2p.count > 0) {
    out.push({
      key: "p2p",
      kind: "p2p",
      text: `Confirm ${plural(s.p2p.count, "P2P payment", "P2P payments")}: Zelle and Venmo wait for you`,
      short: `${s.p2p.count} P2P to confirm`,
      href: "/transactions?review=1",
      asOf: newest([s.p2p.newestImport]),
      order: 0,
    });
  }
  if (s.stale !== null) {
    const names = s.stale.names;
    out.push({
      key: `stale:${[...names].sort().join("|")}`,
      kind: "stale",
      text: `${s.stale.sentence}: reconnect ${names.length === 1 ? "it" : "them"} at SimpleFIN`,
      short: names.length === 1 ? `${names[0]} behind` : `${names.length} accounts behind`,
      href: "/accounts",
      asOf: newest(s.accounts.filter((a) => names.includes(a.name)).map((a) => a.balanceDate)),
      order: 0,
    });
  }
  return out;
}
