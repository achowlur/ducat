"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "../../lib/prisma";
import { generateInsights } from "../../lib/insights/engine";
import { reapplyRules } from "../../lib/sync/rulePack";
import { requireSession } from "../../lib/auth/requireSession";
import { TRANSFER_TARGET } from "../../lib/sync/grouping";

/**
 * Manually assign (or clear) a transaction's category. Manual assignments
 * are sacred — rules never override them. Clearing reverts the row to
 * AGGREGATOR so rules may categorize it again on the next pass.
 */
export async function setTransactionCategory(
  transactionId: string,
  categoryId: string | null,
): Promise<void> {
  await requireSession();
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
 * Upsert a user rule (priority band 1-99, so it outranks the pack and may
 * categorize P2P) and apply it retroactively to all non-MANUAL transactions.
 */
async function upsertRule(
  matchValue: string,
  matchField: "MERCHANT" | "DESCRIPTION",
  categoryId: string | null,
  setFlow: "TRANSFER" | null = null,
): Promise<number> {
  const existing = await prisma.rule.findFirst({
    where: { matchField, matchOperator: "CONTAINS", matchValue },
  });
  if (existing === null) {
    await prisma.rule.create({
      data: {
        priority: 50,
        matchField,
        matchOperator: "CONTAINS",
        matchValue,
        setCategoryId: categoryId,
        setFlow,
        enabled: true,
      },
    });
  } else {
    await prisma.rule.update({
      where: { id: existing.id },
      data: { setCategoryId: categoryId, setFlow, enabled: true },
    });
  }

  const recategorized = await reapplyRules(prisma);
  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/trends");
  revalidatePath("/insights");
  return recategorized;
}

/**
 * Create a user rule from a transaction's merchant and apply it retroactively.
 */
export async function createRuleFromMerchant(
  merchant: string,
  categoryId: string,
): Promise<{ recategorized: number }> {
  await requireSession();
  const matchValue = merchant.trim().toLowerCase();
  if (matchValue === "") throw new Error("Merchant is empty — categorize this transaction manually instead.");
  return { recategorized: await upsertRule(matchValue, "MERCHANT", categoryId) };
}

/**
 * Resolve an entire payee group at once (the bulk review queue). One decision
 * writes one rule that covers every past AND future transaction for that payee
 * — the difference between reviewing a CSV backlog payee-by-payee instead of
 * transaction-by-transaction. P2P groups arrive with matchField DESCRIPTION so
 * the rule targets the counterparty, not the payment rail.
 */
export async function categorizeGroup(
  matchValue: string,
  matchField: "MERCHANT" | "DESCRIPTION",
  /** A category id, or TRANSFER_TARGET to mark the payee as a transfer. */
  target: string,
): Promise<{ recategorized: number }> {
  await requireSession();
  const value = matchValue.trim().toLowerCase();
  if (value === "") throw new Error("Payee is empty — categorize these transactions individually instead.");
  // A CONTAINS rule at user priority outranks the whole pack and is exempt from
  // the P2P guard, so a one- or two-character key is a wrecking ball: a Fidelity
  // dividend on Realty Income normalizes its merchant to the ticker "o", and
  // MERCHANT CONTAINS "o" then recategorizes costco, doordash, every Zelle…
  if (value.length < 3) {
    throw new Error(
      `"${value}" is too short to make a rule from — it would match unrelated merchants. Categorize these individually instead.`,
    );
  }
  if (target === "") throw new Error("Pick a category first.");
  return target === TRANSFER_TARGET
    ? { recategorized: await upsertRule(value, matchField, null, "TRANSFER") }
    : { recategorized: await upsertRule(value, matchField, target) };
}

/**
 * Link an inflow to the outflow it pays back. Analytics subtract the
 * amount from the original's category in the original's period, and the
 * inflow stops counting as income.
 */
export async function linkReimbursement(inflowId: string, outflowId: string): Promise<void> {
  await requireSession();
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
  await requireSession();
  await prisma.transaction.update({
    where: { id: inflowId },
    data: { reimbursesId: null },
  });
  await generateInsights(prisma);
  revalidatePath("/transactions");
  revalidatePath("/");
  revalidatePath("/trends");
}
