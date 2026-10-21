"use server";

import { revalidatePath } from "next/cache";
import { databaseRefusal, refuse, type ActionResult } from "../../lib/actionResult";
import { requireSession } from "../../lib/auth/requireSession";
import { prisma } from "../../lib/prisma";
import { BUDGET_KEY, parseBudget, withBudgetEdit, type BudgetEdit } from "../../lib/ui/budget";

/**
 * One change from a budget row: a limit typed (null follows the suggestion
 * again) or the row moved between monthly and yearly. Only that category's
 * entry changes; a Setting that cannot be read refuses rather than being
 * overwritten.
 */
export async function saveBudgetEdit(edit: BudgetEdit): Promise<ActionResult> {
  await requireSession();
  if (typeof edit?.key !== "string" || edit.key.length > 200) return refuse("That category could not be read.");
  try {
    const row = await prisma.setting.findUnique({ where: { key: BUDGET_KEY } });
    if (row !== null) {
      try {
        JSON.parse(row.value);
      } catch {
        return refuse("The saved budget could not be read, so it was left as it is.");
      }
    }
    const next = withBudgetEdit(parseBudget(row?.value ?? null), edit);
    if (!next.ok) return next;
    const value = JSON.stringify(next.choices);
    await prisma.setting.upsert({ where: { key: BUDGET_KEY }, create: { key: BUDGET_KEY, value }, update: { value } });
  } catch (error) {
    const refusal = databaseRefusal(error);
    if (refusal !== null) return refusal;
    throw error;
  }
  revalidatePath("/budget");
  return { ok: true };
}
