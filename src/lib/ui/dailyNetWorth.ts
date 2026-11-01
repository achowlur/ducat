import { crossingAmount } from "../insights/netWorth";

/**
 * Net worth DAY by day, for the stretch where every account has a balance:
 * from Ducat's own syncs, which write one snapshot per account per bank day.
 * The month-ends of /trends' Net worth stay the record; this is what its
 * line shows zoomed in past three months (NetWorthCard).
 *
 * A snapshot is stamped with the BANK's "as of" instant, not the sync's, so:
 * - the day it belongs to is the LOCAL day (localDayKey): a close stamped
 *   9:45pm Eastern is that evening's, though UTC calls it tomorrow;
 * - a bank that posts no new balance for a day (a weekend, a holiday, a
 *   feed that did not refresh) leaves its last one standing, so a balance
 *   counts for up to CARRY_DAYS days after its own. The monthly figures treat
 *   a balance that recent as current too (netWorth.ts).
 * - a brokerage's balance from the feed values the PREVIOUS trading day's
 *   close (its Saturday update moved with Friday's market, its Monday update
 *   not at all): an account marked `priorClose` is dated a day back, so each
 *   point lines up with its market day and a transfer with the balance that
 *   shows it.
 * A day where any account's newest balance is older than that is LEFT OUT and
 * listed (`missing`), never guessed. An account whose last balance is zero with
 * nothing since is closed and counts as zero; one with no balance yet is not
 * part of the total until it has one, and is named while it is not.
 *
 * A TRANSFER between two accounts is one movement, and the two banks show it
 * on different days: the brokerage's evening update holds the money the day
 * it arrives, the bank's afternoon balance still holds it until the debit
 * posts overnight. For that day the money is in both accounts, a spike the
 * size of the transfer, and the other way round a dip. On a cash account
 * (depository or credit) the balance moves by exactly its rows, so the day a
 * transfer took effect is readable: where the balance on the transfer's day
 * does not move by it and a day within CARRY_DAYS does, the balance is read
 * as if the transfer had posted on its date (postingLag). Only a transfer,
 * and only a cash account: an investment account's balance moves with the
 * market as well, and its prior-close dating already puts a deposit on its
 * day. Nothing is adjusted by hand.
 */

export const CARRY_DAYS = 3;
/**
 * A transfer smaller than this is left as the banks show it. Beside a line
 * drawn in tens of thousands it is noise, and a small payment's two legs
 * often carry two dates (a card dates the payment the day it asks, the bank
 * the day it pays), which no reading of one account can reconcile.
 */
export const LAG_MIN = 1_000;
/** A day's residual holds a transfer when it lies within half of it: the day's other rows still to post, small beside it. */
const holds = (residual: number, amount: number) => Math.abs(residual - amount) <= Math.abs(amount) / 2;
/** The daily record begins with the first run this long of days every account reported. */
export const DAILY_RUN = 7;

export interface DayPoint {
  period: string; // "2026-10-16"
  label: string; // "Oct 16"
  value: number;
  estimated: boolean;
  /** Accounts with no balance yet that day, by name: not in the total. */
  leftOut: string[];
  /** Investment accounts' change since the previous point less money moved in or out; null with no comparable point before. */
  marketGains: number | null;
}

export interface DailyNetWorth {
  points: DayPoint[];
  /** Days inside the daily record left out because some account's balance was too old. */
  missing: string[];
}

const DAY_MS = 86_400_000;
const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * What each cash account's balance is read as on the days a transfer had
 * posted late or early (the note at the top): account id, then day, then
 * the amount to add. A transfer's own day shows no move by it (its residual,
 * the day's balance change less the day's rows, holds the transfer back) and
 * a day within CARRY_DAYS after holds it: the transfer counts from its own
 * day to the day before. The other way round, a move before its day: it is
 * taken out of those days. A bank whose afternoon balance never holds the
 * day's own rows leaves every day a residual of the rows around it, so a
 * residual HOLDS a transfer when it lies within half of it, never exactly.
 */
function postingLag(
  plan: readonly { id: string; type: string }[],
  days: readonly { day: string; readings: readonly ({ kind: "value"; balance: number } | { kind: string })[] }[],
  txns: readonly { accountId: string; date: Date; amount: number; flow?: string }[],
): Map<string, Map<string, number>> {
  const lag = new Map<string, Map<string, number>>();
  const add = (id: string, day: string, amount: number) => {
    let m = lag.get(id);
    if (m === undefined) lag.set(id, (m = new Map()));
    m.set(day, round2((m.get(day) ?? 0) + amount));
  };
  plan.forEach((p, i) => {
    if (p.type !== "DEPOSITORY" && p.type !== "CREDIT") return;
    const balanceOn = new Map<string, number>();
    for (const d of days) {
      const r = d.readings[i];
      if (r.kind === "value") balanceOn.set(d.day, (r as { balance: number }).balance);
    }
    const rowsOn = new Map<string, number>();
    const transfers: { day: string; amount: number }[] = [];
    for (const t of txns) {
      if (t.accountId !== p.id) continue;
      const day = t.date.toISOString().slice(0, 10);
      rowsOn.set(day, (rowsOn.get(day) ?? 0) + t.amount);
      if (t.flow === "TRANSFER" && Math.abs(t.amount) >= LAG_MIN) transfers.push({ day, amount: t.amount });
    }
    const residual = (day: string): number | null => {
      const now = balanceOn.get(day);
      const before = balanceOn.get(addDays(day, -1));
      return now === undefined || before === undefined ? null : now - before - (rowsOn.get(day) ?? 0);
    };
    for (const t of transfers) {
      const own = residual(t.day);
      if (own === null || !holds(own, -t.amount)) continue;
      let settled = false;
      for (let k = 1; k <= CARRY_DAYS && !settled; k++) {
        const later = residual(addDays(t.day, k));
        if (later === null || !holds(later, t.amount)) continue;
        for (let j = 0; j < k; j++) add(p.id, addDays(t.day, j), t.amount);
        settled = true;
      }
      for (let k = 1; k <= CARRY_DAYS && !settled; k++) {
        const earlier = residual(addDays(t.day, -k));
        if (earlier === null || !holds(earlier, t.amount)) continue;
        for (let j = 1; j <= k; j++) add(p.id, addDays(t.day, -j), -t.amount);
        settled = true;
      }
    }
  });
  return lag;
}

/** "Oct 16" from "2026-10-16". */
export function dayLabel(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function dailyNetWorth(input: {
  /** `priorClose`: the feed's balance values the previous trading day's close (an aggregator-fed brokerage). */
  accounts: readonly { id: string; name: string; type: string; priorClose?: boolean }[];
  snapshots: readonly { accountId: string; date: Date; balance: number }[];
  txns: readonly { accountId: string; date: Date; amount: number; description: string; flow?: string }[];
  /** The local day an instant falls on (localDayKey). */
  dayOf: (d: Date) => string;
  /** Today, as a local day key. */
  today: string;
}): DailyNetWorth {
  const { accounts, snapshots, txns, dayOf, today } = input;

  // Each account's balance per local day: the latest instant that day, a
  // day earlier for a balance that values the close before it.
  const prior = new Set(accounts.filter((a) => a.priorClose === true).map((a) => a.id));
  const dayFor = (id: string, d: Date) => (prior.has(id) ? addDays(dayOf(d), -1) : dayOf(d));
  const byAccount = new Map<string, Map<string, { at: number; balance: number }>>();
  const newest = new Map<string, { at: number; balance: number }>();
  for (const s of snapshots) {
    const at = s.date.getTime();
    const day = dayFor(s.accountId, s.date);
    let days = byAccount.get(s.accountId);
    if (days === undefined) byAccount.set(s.accountId, (days = new Map()));
    const seen = days.get(day);
    if (seen === undefined || at > seen.at) days.set(day, { at, balance: s.balance });
    const last = newest.get(s.accountId);
    if (last === undefined || at > last.at) newest.set(s.accountId, { at, balance: s.balance });
  }

  const lastTxn = new Map<string, number>();
  for (const t of txns) lastTxn.set(t.accountId, Math.max(lastTxn.get(t.accountId) ?? 0, t.date.getTime()));

  const plan = accounts.map((a) => {
    const days = byAccount.get(a.id) ?? new Map<string, { at: number; balance: number }>();
    const last = newest.get(a.id);
    // Closed: its last balance is zero and nothing has moved since.
    const closedFrom =
      last !== undefined && last.balance === 0 && (lastTxn.get(a.id) ?? 0) <= last.at ? dayFor(a.id, new Date(last.at)) : null;
    const first = days.size === 0 ? null : [...days.keys()].sort()[0];
    return { ...a, days, closedFrom, first };
  });

  type Reading = { kind: "value"; balance: number; closed?: true } | { kind: "absent" } | { kind: "unknown" };
  const read = (p: (typeof plan)[number], day: string): Reading => {
    if (p.closedFrom !== null && day >= p.closedFrom) return { kind: "value", balance: 0, closed: true };
    for (let k = 0; k <= CARRY_DAYS; k++) {
      const hit = p.days.get(addDays(day, -k));
      if (hit !== undefined) return { kind: "value", balance: hit.balance };
    }
    return p.first === null || p.first > day ? { kind: "absent" } : { kind: "unknown" };
  };

  const firsts = plan.map((p) => p.first).filter((d): d is string => d !== null);
  if (firsts.length === 0) return { points: [], missing: [] };
  const from = firsts.sort()[0];

  // Every day from the first balance on record to today: whole, or not.
  const days: { day: string; whole: boolean; readings: Reading[] }[] = [];
  for (let day = from; day <= today; day = addDays(day, 1)) {
    const readings = plan.map((p) => read(p, day));
    // A closed account's zero alone makes no day: some open account must report.
    const whole = readings.every((r) => r.kind !== "unknown") && readings.some((r) => r.kind === "value" && r.closed !== true);
    days.push({ day, whole, readings });
  }
  const start = days.findIndex((_, i) => days.slice(i, i + DAILY_RUN).length === DAILY_RUN && days.slice(i, i + DAILY_RUN).every((d) => d.whole));
  if (start < 0) return { points: [], missing: [] };

  const lag = postingLag(plan, days, txns);

  // Money crossing an investment account's boundary, by the transaction's own
  // (UTC-pinned) date, the day its balance shows it: what the markets' share
  // leaves out.
  const investment = new Set(accounts.filter((a) => a.type === "INVESTMENT").map((a) => a.id));
  const flowsOn = new Map<string, Map<string, number>>();
  for (const t of txns) {
    if (!investment.has(t.accountId)) continue;
    const crossing = crossingAmount(t);
    if (crossing === 0) continue;
    const day = t.date.toISOString().slice(0, 10);
    let m = flowsOn.get(day);
    if (m === undefined) flowsOn.set(day, (m = new Map()));
    m.set(t.accountId, (m.get(t.accountId) ?? 0) + crossing);
  }

  const points: DayPoint[] = [];
  const missing: string[] = [];
  let prev: { day: string; invTotal: number; leftOut: string[] } | null = null;
  for (const d of days.slice(start)) {
    if (!d.whole) {
      missing.push(d.day);
      continue;
    }
    let value = 0;
    let invTotal = 0;
    const leftOut: string[] = [];
    d.readings.forEach((r, i) => {
      if (r.kind !== "value") {
        leftOut.push(plan[i].name);
        return;
      }
      value += r.balance + (lag.get(plan[i].id)?.get(d.day) ?? 0);
      if (investment.has(plan[i].id)) invTotal += r.balance;
    });
    let marketGains: number | null = null;
    if (prev !== null && sameSet(prev.leftOut, leftOut)) {
      let flows = 0;
      for (let day = addDays(prev.day, 1); day <= d.day; day = addDays(day, 1)) {
        for (const [id, amount] of flowsOn.get(day) ?? []) if (!leftOut.includes(plan.find((p) => p.id === id)?.name ?? "")) flows += amount;
      }
      marketGains = round2(invTotal - prev.invTotal - flows);
    }
    points.push({ period: d.day, label: dayLabel(d.day), value: round2(value), estimated: false, leftOut, marketGains });
    prev = { day: d.day, invTotal, leftOut };
  }
  // A gap at the very end is today not having reported yet, not a day lost.
  while (missing.length > 0 && missing.at(-1)! > (points.at(-1)?.period ?? "")) missing.pop();
  return { points, missing };
}
