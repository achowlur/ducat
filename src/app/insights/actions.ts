"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "../../lib/prisma";
import { requireSession } from "../../lib/auth/requireSession";
import { databaseRefusal, refuse, type ActionResult } from "../../lib/actionResult";
import { SAVINGS_GOALS_KEY, withGoalPace } from "../../lib/insights/goals";
import type { RecurringChargePayload } from "../../types/contracts";
import { periodKey } from "../../lib/insights/periods";
import {
  decide,
  livePlans,
  parseDecisions,
  RECURRING_DECISIONS_KEY,
  type Choice,
} from "../../lib/ui/recurringDecisions";
import { NEW_PAY_KEY, parseNewPay } from "../../lib/ui/payLevel";
import {
  NET_WORTH_GOAL_KEY,
  nextNetWorthGoal,
  parseNetWorthGoal,
  type NetWorthGoal,
} from "../../lib/ui/netWorthGoal";

/**
 * Dismiss or restore an insight. Dismissals survive regeneration: the
 * engine carries the flag forward to the replacement row with the same
 * identity (see identityOf in src/lib/insights/engine.ts).
 */
export async function setInsightDismissed(insightId: string, dismissed: boolean): Promise<void> {
  await requireSession();
  await prisma.insight.update({
    where: { id: insightId },
    data: { dismissed },
  });
  revalidatePath("/insights");
  revalidatePath("/");
}

/**
 * Confirm a paycheck at a new amount as the operator's new pay, so the paces
 * project from it before it repeats (ui/payLevel.ts). Keeps the last few
 * confirmations; a stale one confirms nothing once newer paychecks exist.
 */
export async function confirmNewPay(input: { payer: string; date: string }): Promise<ActionResult> {
  await requireSession();
  if (typeof input.payer !== "string" || input.payer === "" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false, message: "That paycheck could not be read." };
  }
  const row = await prisma.setting.findUnique({ where: { key: NEW_PAY_KEY } });
  const kept = parseNewPay(row?.value ?? null).filter((c) => !(c.payer === input.payer && c.date === input.date));
  const value = JSON.stringify([...kept, { payer: input.payer, date: input.date }].slice(-10));
  await prisma.setting.upsert({ where: { key: NEW_PAY_KEY }, create: { key: NEW_PAY_KEY, value }, update: { value } });
  revalidatePath("/insights");
  return { ok: true };
}

/**
 * Save the net worth goal's target, market return and monthly figures from
 * the panel's controls (the goals command writes the same Setting). Refusals come back
 * as values, shown beside the control (lib/actionResult.ts).
 */
export async function saveNetWorthGoal(input: {
  target: number;
  realReturnPct: number;
  /** Null: the deposit follows the data. */
  monthlyInvest: number | null;
  /** Null: the saving pace follows the data. */
  monthlyPace: number | null;
}): Promise<ActionResult<{ goal: NetWorthGoal }>> {
  await requireSession();
  const row = await prisma.setting.findUnique({ where: { key: NET_WORTH_GOAL_KEY } });
  const next = nextNetWorthGoal(parseNetWorthGoal(row?.value ?? null), input, new Date().toISOString().slice(0, 10));
  if (!next.ok) return next;
  const value = JSON.stringify(next.goal);
  await prisma.setting.upsert({
    where: { key: NET_WORTH_GOAL_KEY },
    create: { key: NET_WORTH_GOAL_KEY, value },
    update: { value },
  });
  revalidatePath("/insights");
  return next;
}

/**
 * Save (or clear, with null) one savings goal's "Saved per month" from its
 * card. Only that field of that entry changes: the Setting is rewritten from
 * its raw entries (withGoalPace), so nothing else in it is touched, and an
 * unreadable Setting refuses rather than being overwritten.
 */
export async function saveSavingsGoalPace(input: {
  id: string;
  /** Null: the card follows the measured pace. */
  monthlyPace: number | null;
}): Promise<ActionResult> {
  await requireSession();
  const row = await prisma.setting.findUnique({ where: { key: SAVINGS_GOALS_KEY } });
  const next = withGoalPace(row?.value ?? null, input.id, input.monthlyPace);
  if (!next.ok) return next;
  await prisma.setting.upsert({
    where: { key: SAVINGS_GOALS_KEY },
    create: { key: SAVINGS_GOALS_KEY, value: next.value },
    update: { value: next.value },
  });
  revalidatePath("/insights");
  return { ok: true };
}

/**
 * An alert's button on Recurring charges (components/RecurringAlerts): keep a
 * price rise, say a plan is still charging, or mark it cancelled. The decision
 * is stored in a Setting and changes what the page shows and counts; it never
 * touches a transaction. The plan is looked up in this month's recurring rows
 * on the server, so a stale page is refused in a sentence, never trusted.
 */
export async function decideRecurring(input: { plan: string; choice: Choice }): Promise<ActionResult<{ message: string }>> {
  await requireSession();
  if (typeof input.plan !== "string" || input.plan === "" || input.plan.length > 200) {
    return refuse("That plan could not be read.");
  }
  if (input.choice !== "keep" && input.choice !== "still" && input.choice !== "cancel" && input.choice !== "unshared") {
    return refuse("That answer could not be read.");
  }
  const now = new Date();
  try {
    const [rows, setting] = await Promise.all([
      prisma.insight.findMany({ where: { type: "RECURRING_CHARGE", period: periodKey(now, "MONTH") } }),
      prisma.setting.findUnique({ where: { key: RECURRING_DECISIONS_KEY } }),
    ]);
    const decisions = parseDecisions(setting?.value ?? null);
    const plans = livePlans(rows.map((r) => r.payload as unknown as RecurringChargePayload), decisions, now);
    const next = decide(input.choice, input.plan, plans, decisions, now);
    if (!next.ok) return next;
    const value = JSON.stringify(next.decisions);
    await prisma.setting.upsert({
      where: { key: RECURRING_DECISIONS_KEY },
      create: { key: RECURRING_DECISIONS_KEY, value },
      update: { value },
    });
  } catch (error) {
    const refusal = databaseRefusal(error);
    if (refusal !== null) return refusal;
    throw error;
  }
  revalidatePath("/insights");
  return { ok: true, message: "Saved." };
}
