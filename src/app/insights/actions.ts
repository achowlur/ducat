"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "../../lib/prisma";
import { requireSession } from "../../lib/auth/requireSession";
import type { ActionResult } from "../../lib/actionResult";
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
