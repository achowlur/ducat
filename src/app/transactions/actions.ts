"use server";

import { revalidatePath } from "next/cache";
import { revalidateInsightPages } from "../revalidate";
import { prisma } from "../../lib/prisma";
import { generateInsights } from "../../lib/insights/engine";
import { reapplyRules, type GroupUndo } from "../../lib/sync/rulePack";
import { requireSession } from "../../lib/auth/requireSession";
import { TRANSFER_TARGET } from "../../lib/sync/grouping";
import { draftSubscription } from "../../lib/health/registerSubscription";
import type { RecurringCadence } from "../../types/contracts";

/** Guarded because a server action's arguments arrive from the client. */
const CADENCES = new Set<RecurringCadence>([
  "WEEKLY",
  "BIWEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "YEARLY",
]);

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
  revalidateInsightPages();
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
): Promise<{ recategorized: number; undo: GroupUndo }> {
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

  const { changed, restore } = await reapplyRules(prisma);
  revalidatePath("/transactions");
  revalidateInsightPages();
  return {
    recategorized: changed,
    undo: {
      matchValue,
      matchField,
      previousRule:
        existing === null
          ? null
          : { categoryId: existing.setCategoryId, flow: existing.setFlow === "TRANSFER" ? "TRANSFER" : null },
      restore,
    },
  };
}

const FLOWS = new Set(["INFLOW", "OUTFLOW", "TRANSFER"]);
const SOURCES = new Set(["MANUAL", "RULE", "AGGREGATOR"]);

/**
 * Reverse the last bulk categorization. Deleting the rule is not enough on its
 * own — rules only write to rows they match, so the rows it already
 * categorized would keep their new category with nothing left to explain it.
 */
export async function undoCategorizeGroup(undo: GroupUndo): Promise<void> {
  await requireSession();
  const rule = await prisma.rule.findFirst({
    where: { matchField: undo.matchField, matchOperator: "CONTAINS", matchValue: undo.matchValue },
  });
  if (rule !== null) {
    if (undo.previousRule === null) {
      await prisma.rule.delete({ where: { id: rule.id } });
    } else {
      await prisma.rule.update({
        where: { id: rule.id },
        data: { setCategoryId: undo.previousRule.categoryId, setFlow: undo.previousRule.flow },
      });
    }
  }
  for (const t of undo.restore) {
    if (!FLOWS.has(t.flow) || !SOURCES.has(t.categorySource)) continue;
    await prisma.transaction.update({
      where: { id: t.id },
      data: { categoryId: t.categoryId, categorySource: t.categorySource, flow: t.flow },
    });
  }
  await generateInsights(prisma);
  revalidatePath("/transactions");
  revalidateInsightPages();
}

/**
 * Create a user rule from a transaction's merchant and apply it retroactively.
 */
export async function createRuleFromMerchant(
  merchant: string,
  categoryId: string,
  /**
   * DESCRIPTION for a P2P row, where the counterparty appears in the
   * description and the merchant is the generic rail — a MERCHANT rule built
   * from "zelle transfer" would categorize every P2P payment at once.
   */
  matchField: "MERCHANT" | "DESCRIPTION" = "MERCHANT",
): Promise<{ recategorized: number }> {
  await requireSession();
  const matchValue = merchant.trim().toLowerCase();
  if (matchValue === "") throw new Error("Merchant is empty — categorize this transaction manually instead.");
  // Same floor as the grouped review: a CONTAINS rule at user priority outranks
  // the whole pack, so a one- or two-character value is a wrecking ball.
  if (matchValue.length < 3) {
    throw new Error(
      `"${matchValue}" is too short to make a rule from — it would match unrelated transactions.`,
    );
  }
  if (matchField !== "MERCHANT" && matchField !== "DESCRIPTION") {
    throw new Error("Unknown match field.");
  }
  const { recategorized } = await upsertRule(matchValue, matchField, categoryId);
  return { recategorized };
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
): Promise<{ recategorized: number; undo: GroupUndo }> {
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
    ? upsertRule(value, matchField, null, "TRANSFER")
    : upsertRule(value, matchField, target);
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
  revalidateInsightPages();
}

/**
 * Track a transaction's merchant as a subscription.
 *
 * Detection needs three occurrences at a regular cadence, which structurally
 * cannot cover an annual plan (three yearly charges need three years) or a
 * merchant whose descriptor shifts between charges — `npm run subs:audit`
 * names the annual case as the detector's one honest gap. Registering is the
 * door for both, and it is what makes the next renewal date and cent-exact
 * price drift available from the FIRST charge rather than the third.
 */
export async function registerSubscription(
  transactionId: string,
  cadence: RecurringCadence,
): Promise<void> {
  await requireSession();
  if (!CADENCES.has(cadence)) throw new Error(`Unknown cadence "${cadence}".`);

  const txn = await prisma.transaction.findUniqueOrThrow({
    where: { id: transactionId },
    select: { normalizedMerchant: true, description: true, amount: true, date: true },
  });
  const draft = draftSubscription({
    normalizedMerchant: txn.normalizedMerchant,
    description: txn.description,
    amount: Number(txn.amount),
    date: txn.date,
    cadence,
  });
  if (draft === null) {
    throw new Error(
      "This row can't be tracked: a subscription needs an outflow with a merchant name of at least three characters.",
    );
  }

  // Re-registering the same merchant updates it rather than listing it twice,
  // the same shape `upsertRule` uses — the pattern is the identity.
  const existing = await prisma.trackedSubscription.findFirst({
    where: { merchantPattern: draft.merchantPattern },
  });
  if (existing === null) {
    await prisma.trackedSubscription.create({ data: { ...draft, enabled: true } });
  } else {
    await prisma.trackedSubscription.update({
      where: { id: existing.id },
      data: { ...draft, enabled: true },
    });
  }

  revalidatePath("/transactions");
  revalidatePath("/");
}

/** Stop tracking. Nothing else is touched — the transactions keep their category. */
export async function unregisterSubscription(merchantPattern: string): Promise<void> {
  await requireSession();
  await prisma.trackedSubscription.deleteMany({ where: { merchantPattern } });
  revalidatePath("/transactions");
  revalidatePath("/");
}

export async function unlinkReimbursement(inflowId: string): Promise<void> {
  await requireSession();
  await prisma.transaction.update({
    where: { id: inflowId },
    data: { reimbursesId: null },
  });
  await generateInsights(prisma);
  revalidatePath("/transactions");
  revalidateInsightPages();
}
