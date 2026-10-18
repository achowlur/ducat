import { samePay } from "../insights/oneOffPay";
import { round2 } from "../insights/stats";
import type { PayItem } from "../../types/contracts";

/**
 * Pay as it is NOW, and what the paces owe a raise.
 *
 * A pace averaged over six months reflects a raise only a sixth at a time:
 * five months after it, most of the window still holds the old pay. So the
 * paces project from the CURRENT paycheck: each earlier paycheck in the
 * window counts at today's amount (its TOP-UP, the difference), a raise and a
 * cut alike. The current amount is the latest paycheck once it repeats, or
 * once the operator says it is the new pay (the button on the goal panel,
 * Setting pay.newPay); until then a paycheck at a new amount counts as
 * itself, and the panel asks. Only PAYCHECKS (insights/oneOffPay.ts): a bonus
 * beside a paycheck is never a raise, two months running or not.
 *
 * A JOB CHANGE is the same question across two payers. Pay is judged per
 * payer, so after a move the old salary stayed in the window at its own
 * level, read as today's. A payer whose paychecks STOPPED (none for two of
 * its own pay cycles, and at least 35 days, before the newest paycheck on
 * record) is replaced by the one payer that started after its last payday:
 * every month it paid, and the new one did not, counts at the new payer's
 * pay now, a MONTH's worth (its paycheck times its paydays a month, since
 * the two may pay on different cycles). With one new paycheck only, or
 * several new payers, it is not assumed: the panel asks, through the same
 * "This is my new pay" the operator presses for a raise. Two payers paying
 * at once are two jobs, never a change.
 */

/** Paychecks the operator confirmed as their new pay: payer and day. */
export const NEW_PAY_KEY = "pay.newPay";

export interface NewPay {
  payer: string;
  date: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The stored Setting → confirmations; tolerant, a corrupted value confirms nothing. */
export function parseNewPay(raw: string | null): NewPay[] {
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is NewPay =>
        typeof x === "object" && x !== null && typeof x.payer === "string" && typeof x.date === "string" && DAY.test(x.date),
    );
  } catch {
    return [];
  }
}

/** A payer's pay changed and the paces project from the new amount. */
export interface PayChange {
  payer: string;
  from: number;
  to: number;
  /** First payday at the new amount. */
  since: string;
  /** True when the operator said so before it repeated. */
  told: boolean;
  /**
   * The payer whose paychecks stopped, on a job change: `from` and `to` are
   * then a MONTH's pay at each, the two possibly paid on different cycles.
   */
  replaces?: string;
}

/** A paycheck at a new amount that has not repeated: counted as itself until it does, or the operator says. */
export interface PendingPay {
  payer: string;
  date: string;
  amount: number;
  from: number;
  /** The payer whose paychecks stopped, when this paycheck may be a new job's. */
  replaces?: string;
}

export interface PayLevels {
  /** Each month's top-up ("2026-05"): today's pay less what each earlier paycheck that month paid. */
  topUps: Record<string, number>;
  /** The latest change per payer, when one is in effect. */
  changes: PayChange[];
  pending: PendingPay[];
}

/** Paydays per payer, oldest first, each day's paychecks summed (a paycheck split across accounts is one). */
function paydaysOf(paychecks: readonly PayItem[]): Map<string, { date: string; total: number }[]> {
  const byPayer = new Map<string, Map<string, number>>();
  for (const p of paychecks) {
    const days = byPayer.get(p.payer) ?? new Map<string, number>();
    days.set(p.date, round2((days.get(p.date) ?? 0) + p.amount));
    byPayer.set(p.payer, days);
  }
  const out = new Map<string, { date: string; total: number }[]>();
  for (const [payer, days] of byPayer) {
    out.set(
      payer,
      [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, total]) => ({ date, total })),
    );
  }
  return out;
}

const DAY_MS = 86_400_000;
const MONTH_DAYS = 30.4375;
/** A payer is gone once silent this many of its cycles, and at least STOPPED_MIN_DAYS. */
const STOPPED_CYCLES = 2;
const STOPPED_MIN_DAYS = 35;

const at = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The middle gap between a payer's paydays, in days; null with one payday. */
function usualGap(days: readonly { date: string }[]): number | null {
  if (days.length < 2) return null;
  const gaps = days.slice(1).map((d, k) => (at(d.date) - at(days[k].date)) / DAY_MS).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

export function payLevels(paychecks: readonly PayItem[], told: readonly NewPay[]): PayLevels {
  // Kept per payer, so a payer a job change replaces can give its own up.
  const topUpsBy = new Map<string, Record<string, number>>();
  const changes: PayChange[] = [];
  const pending: PendingPay[] = [];
  const levels = new Map<string, number>();
  const byPayer = paydaysOf(paychecks);
  for (const [payer, days] of byPayer) {
    if (days.length < 2) {
      if (days.length === 1) levels.set(payer, days[0].total);
      continue;
    }
    let end = days.length - 1;
    const latest = days[end];
    const before = days[end - 1];
    let byWord = false;
    if (!samePay(latest.total, before.total)) {
      if (told.some((t) => t.payer === payer && t.date === latest.date)) byWord = true;
      else {
        // Not repeated and not confirmed: it counts as itself, and today's
        // pay is the run before it.
        pending.push({ payer, date: latest.date, amount: latest.total, from: before.total });
        end -= 1;
      }
    }
    const current = days[end].total;
    levels.set(payer, current);
    let start = end;
    while (!byWord && start > 0 && samePay(days[start - 1].total, current)) start -= 1;
    const since = days[start].date;
    if (start > 0) changes.push({ payer, from: days[start - 1].total, to: current, since, told: byWord });
    const own: Record<string, number> = {};
    for (const d of days) {
      if (d.date >= since || samePay(d.total, current)) continue;
      const month = d.date.slice(0, 7);
      own[month] = round2((own[month] ?? 0) + current - d.total);
    }
    topUpsBy.set(payer, own);
  }

  // Job changes: a payer that stopped, and the one that started after it.
  const newest = Math.max(...[...byPayer.values()].map((days) => at(days[days.length - 1].date)));
  for (const [former, days] of byPayer) {
    const last = days[days.length - 1].date;
    const gap = usualGap(days);
    if (gap === null || newest - at(last) <= Math.max(STOPPED_CYCLES * gap, STOPPED_MIN_DAYS) * DAY_MS) continue;
    const successors = [...byPayer].filter(([p, d]) => p !== former && d[0].date > last);
    const fromMonth = round2((levels.get(former) ?? 0) * (MONTH_DAYS / gap));
    const chosen = successors.filter(([p, d]) => told.some((t) => t.payer === p && d.some((x) => x.date === t.date)));
    const next = chosen.length === 1 ? chosen[0] : successors.length === 1 && successors[0][1].length >= 2 ? successors[0] : null;
    if (next === null) {
      // Not assumed: each paycheck that may be the new job's asks.
      for (const [p, d] of successors) {
        const newestDay = d[d.length - 1];
        if (pending.some((x) => x.payer === p && x.date === newestDay.date)) continue;
        pending.push({ payer: p, date: newestDay.date, amount: newestDay.total, from: levels.get(former) ?? 0, replaces: former });
      }
      continue;
    }
    const [payer, newDays] = next;
    const toMonth = round2((levels.get(payer) ?? 0) * (MONTH_DAYS / (usualGap(newDays) ?? gap)));
    const paidNew = new Set(newDays.map((d) => d.date.slice(0, 7)));
    const paidOld = new Map<string, number>();
    for (const d of days) paidOld.set(d.date.slice(0, 7), round2((paidOld.get(d.date.slice(0, 7)) ?? 0) + d.total));
    // Every month the old job paid, and the new one did not, counts at a
    // month of the new pay; the old payer's own top-ups and raises go.
    const replaced: Record<string, number> = {};
    for (const [month, paid] of paidOld) if (!paidNew.has(month)) replaced[month] = round2(toMonth - paid);
    topUpsBy.set(former, replaced);
    for (let k = changes.length - 1; k >= 0; k -= 1) if (changes[k].payer === former) changes.splice(k, 1);
    for (let k = pending.length - 1; k >= 0; k -= 1) if (pending[k].payer === payer && pending[k].replaces === former) pending.splice(k, 1);
    changes.push({ payer, from: fromMonth, to: toMonth, since: newDays[0].date, told: chosen.length === 1, replaces: former });
  }

  const topUps: Record<string, number> = {};
  for (const own of topUpsBy.values()) {
    for (const [month, amount] of Object.entries(own)) topUps[month] = round2((topUps[month] ?? 0) + amount);
  }
  return { topUps, changes, pending };
}
