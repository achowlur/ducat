"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "../../lib/prisma";
import { generateInsights } from "../../lib/insights/engine";
import { reapplyRules } from "../../lib/sync/rulePack";

/**
 * Manually assign (or clear) a transaction's category. Manual assignments
 * are sacred — rules never override them. Clearing reverts the row to
 * AGGREGATOR so rules may categorize it again on the next pass.
 */
export async function setTransactionCategory(
  transactionId: string,
  categoryId: string | null,
): Promise<void> {
  await prisma.transaction.update({
    where: { id: transactionId },
    data: {
      categoryId,
      categorySource: categoryId === null ? "AGGREGATOR" : "MANUAL",
    },
  });
  await generateInsights(prisma);
  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/trends");
}

/**
 * Create a user rule (priority band 1-99) from a transaction's merchant
 * and apply it retroactively to all non-MANUAL transactions.
 */
export async function createRuleFromMerchant(
  merchant: string,
  categoryId: string,
): Promise<{ recategorized: number }> {
  const matchValue = merchant.trim().toLowerCase();
  if (matchValue === "") throw new Error("Merchant is empty — categorize this transaction manually instead.");

  const existing = await prisma.rule.findFirst({
    where: { matchField: "MERCHANT", matchOperator: "CONTAINS", matchValue },
  });
  if (existing === null) {
    await prisma.rule.create({
      data: {
        priority: 50,
        matchField: "MERCHANT",
        matchOperator: "CONTAINS",
        matchValue,
        setCategoryId: categoryId,
        enabled: true,
      },
    });
  } else {
    await prisma.rule.update({ where: { id: existing.id }, data: { setCategoryId: categoryId, enabled: true } });
  }

  const recategorized = await reapplyRules(prisma);
  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/trends");
  return { recategorized };
}

/**
 * Link an inflow to the outflow it pays back. Analytics subtract the
 * amount from the original's category in the original's period, and the
 * inflow stops counting as income.
 */
export async function linkReimbursement(inflowId: string, outflowId: string): Promise<void> {
  const [inflow, outflow] = await Promise.all([
    prisma.transaction.findUniqueOrThrow({ where: { id: inflowId } }),
    prisma.transaction.findUniqueOrThrow({ where: { id: outflowId } }),
  ]);
  if (inflow.flow !== "INFLOW") throw new Error("Only an inflow can reimburse an expense.");
  if (outflow.flow !== "OUTFLOW") throw new Error("Reimbursements must point at an outflow.");
  await prisma.transaction.update({
    where: { id: inflowId },
    data: { reimbursesId: outflowId },
  });
  await generateInsights(prisma);
  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/trends");
}

export async function unlinkReimbursement(inflowId: string): Promise<void> {
  await prisma.transaction.update({
    where: { id: inflowId },
    data: { reimbursesId: null },
  });
  await generateInsights(prisma);
  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/trends");
}
