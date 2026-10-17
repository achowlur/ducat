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
}

/** A paycheck at a new amount that has not repeated: counted as itself until it does, or the operator says. */
export interface PendingPay {
  payer: string;
  date: string;
  amount: number;
  from: number;
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

export function payLevels(paychecks: readonly PayItem[], told: readonly NewPay[]): PayLevels {
  const topUps: Record<string, number> = {};
  const changes: PayChange[] = [];
  const pending: PendingPay[] = [];
  for (const [payer, days] of paydaysOf(paychecks)) {
    if (days.length < 2) continue;
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
    let start = end;
    while (!byWord && start > 0 && samePay(days[start - 1].total, current)) start -= 1;
    const since = days[start].date;
    if (start > 0) changes.push({ payer, from: days[start - 1].total, to: current, since, told: byWord });
    for (const d of days) {
      if (d.date >= since || samePay(d.total, current)) continue;
      const month = d.date.slice(0, 7);
      topUps[month] = round2((topUps[month] ?? 0) + current - d.total);
    }
  }
  return { topUps, changes, pending };
}
