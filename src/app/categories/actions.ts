"use server";

import { revalidatePath } from "next/cache";
import { revalidateInsightPages } from "../revalidate";
import { prisma } from "../../lib/prisma";
import { generateInsights } from "../../lib/insights/engine";
import { requireSession } from "../../lib/auth/requireSession";
import { deleteUserCategory, renameUserCategory } from "../../lib/categoryEdits";
import type { ActionResult } from "../../lib/actionResult";

/*
 * Both REFUSE by returning (lib/actionResult.ts): a thrown message is replaced
 * in production, so the reason would never reach the control that asked.
 */

/** Every page that lists category names: this one, the ledger's picker and filter, and the insight pages. */
function expireCategoryPages(): void {
  revalidatePath("/categories");
  revalidatePath("/transactions");
  revalidateInsightPages();
}

/**
 * Rename one of the operator's own categories (lib/categories.ts). Insights
 * regenerate because their payloads carry category NAMES: without it the
 * digest and the archive would print the old one until the next sync.
 */
export async function renameCategory(id: string, name: string): Promise<ActionResult<{ name: string }>> {
  await requireSession();
  const renamed = await renameUserCategory(prisma, id, name);
  if (!renamed.ok) return renamed;
  if (renamed.changed) {
    await generateInsights(prisma);
    expireCategoryPages();
  }
  return { ok: true, name: renamed.name };
}

/**
 * Delete one of the operator's own categories, moving its rows and rules into
 * `moveTo` (an id) or clearing them (null). The page states which before the
 * operator presses delete; nothing undoes it but choosing again.
 */
export async function deleteCategory(
  id: string,
  moveTo: string | null,
): Promise<ActionResult<{ name: string; moved: number; rulesMoved: number; rulesRemoved: number }>> {
  await requireSession();
  const deleted = await deleteUserCategory(prisma, id, moveTo);
  if (!deleted.ok) return deleted;
  await generateInsights(prisma);
  expireCategoryPages();
  return deleted;
}
