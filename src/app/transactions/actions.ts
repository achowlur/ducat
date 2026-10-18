"use server";

import { revalidatePath } from "next/cache";
import { revalidateInsightPages } from "../revalidate";
import { prisma } from "../../lib/prisma";
import { regenerateForRows } from "../../lib/insights/scope";
import { confirmP2PMatches, reapplyRules, restoreTransactions, type GroupUndo } from "../../lib/sync/rulePack";
import { renameGroupRows } from "../../lib/sync/groups";
import { MAX_GROUP_LABEL, normalizeGroupLabel } from "../../lib/ui/groupFilter";
import { requireSession } from "../../lib/auth/requireSession";
import { refuse, type ActionResult } from "../../lib/actionResult";
import { createUserCategory } from "../../lib/categories";
import { whenCleared } from "../../lib/sync/closedBox";
import { TRANSFER_TARGET } from "../../lib/sync/grouping";
import { draftSubscription } from "../../lib/health/registerSubscription";
import {
  makeCandidateFinder,
  REIMBURSE_LEAD_DAYS,
  REIMBURSE_POOL_TAKE,
  REIMBURSE_WINDOW_DAYS,
  searchCandidates,
  type ReimburseCandidate,
} from "../../lib/ui/reimburseCandidates";
import type { RecurringCadence } from "../../types/contracts";

/*
 * Every REFUSAL below is returned, never thrown (lib/actionResult.ts): a thrown
 * message is replaced in production, so the reason never reached the control.
 * What still throws is the unexpected, which is the error boundary's to show.
 */

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
 *
 * Inside an investment account, clearing encloses the row at once rather
 * than on that next pass (see whenCleared): there the row is a transfer by
 * its account's type, and leaving it uncategorized in the meantime counts it.
 */
export async function setTransactionCategory(
  transactionId: string,
  categoryId: string | null,
): Promise<void> {
  await requireSession();
  if (categoryId === null) {
    const row = await prisma.transaction.findUniqueOrThrow({
      where: { id: transactionId },
      select: { account: { select: { type: true } } },
    });
    await prisma.transaction.update({ where: { id: transactionId }, data: whenCleared(row.account.type) });
  } else {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { categoryId, categorySource: "MANUAL" },
    });
  }
  await regenerateForRows(prisma, { id: transactionId });
  revalidatePath("/transactions");
  revalidateInsightPages();
}

/**
 * Add a category of the operator's own (lib/categories.ts), returning the one
 * to assign. That is the EXISTING category when the name is already taken in
 * any casing, so a stale picker cannot fork "groceries" beside "Groceries".
 *
 * Assigns nothing itself: the picker follows it with the same write an
 * existing category gets, so a new category reaches a row, or a rule, by the
 * one path that already protects MANUAL rows and regenerates insights.
 */
export async function createCategory(
  name: string,
  isIncome: boolean,
): Promise<ActionResult<{ id: string; name: string }>> {
  await requireSession();
  const made = await createUserCategory(prisma, name, isIncome === true);
  if (!made.ok) return made;
  // The picker's list and the filter's options are this page's props.
  if (made.created) revalidatePath("/transactions");
  return { ok: true, id: made.id, name: made.name };
}

/** A user rule a decision writes: a category, or (setFlow TRANSFER) no category. */
interface RuleDecision {
  matchValue: string;
  matchField: "MERCHANT" | "DESCRIPTION";
  categoryId: string | null;
  setFlow: "TRANSFER" | null;
}

const ruleKey = (r: { matchField: string; matchValue: string }) => `${r.matchField}|${r.matchValue}`;

/** Rules matched by field and value, the identity a review decision writes under. */
function ruleIdentities(rules: { matchField: "MERCHANT" | "DESCRIPTION"; matchValue: string }[]) {
  return {
    matchOperator: "CONTAINS" as const,
    OR: rules.map((r) => ({ matchField: r.matchField, matchValue: r.matchValue })),
  };
}

/**
 * Upsert user rules (priority band 1-99, so they outrank the pack and may
 * categorize P2P) and apply them retroactively to all non-MANUAL transactions.
 * One decision or a batch: existing rules are read in one query, new ones made
 * in one write, and the stored rows re-read once for the whole batch.
 */
async function upsertRules(decisions: RuleDecision[]): Promise<{ recategorized: number; undo: GroupUndo }> {
  // The same payee twice in one batch: the later choice is the decision.
  const unique = [...new Map(decisions.map((d) => [ruleKey(d), d])).values()];
  const existing = await prisma.rule.findMany({ where: ruleIdentities(unique) });
  const existingByKey = new Map(existing.map((r) => [ruleKey(r), r]));

  const toCreate = unique.filter((d) => !existingByKey.has(ruleKey(d)));
  if (toCreate.length > 0) {
    await prisma.rule.createMany({
      data: toCreate.map((d) => ({
        priority: 50,
        matchField: d.matchField,
        matchOperator: "CONTAINS" as const,
        matchValue: d.matchValue,
        setCategoryId: d.categoryId,
        setFlow: d.setFlow,
        enabled: true,
      })),
    });
  }
  for (const d of unique) {
    const was = existingByKey.get(ruleKey(d));
    if (was === undefined) continue;
    await prisma.rule.update({
      where: { id: was.id },
      data: { setCategoryId: d.categoryId, setFlow: d.setFlow, enabled: true },
    });
  }

  // P2P rows first: reapplyRules only SUGGESTS for them now, so each payee's
  // waiting payments are confirmed as the decision this is. They are MANUAL
  // afterwards, which the reapply below then leaves alone.
  const confirmed = await confirmP2PMatches(
    prisma,
    unique.map((d) => ({
      matchField: d.matchField,
      matchOperator: "CONTAINS" as const,
      matchValue: d.matchValue,
      setCategoryId: d.categoryId,
      setFlow: d.setFlow,
    })),
  );
  const reapplied = await reapplyRules(prisma);
  // reapplyRules regenerates insights only when IT changed rows.
  if (confirmed.length > 0 && reapplied.changed === 0) {
    await regenerateForRows(prisma, { id: { in: confirmed.map((r) => r.id) } });
  }
  revalidatePath("/transactions");
  revalidateInsightPages();
  return {
    recategorized: confirmed.length + reapplied.changed,
    undo: {
      rules: unique.map((d) => {
        const was = existingByKey.get(ruleKey(d));
        return {
          matchValue: d.matchValue,
          matchField: d.matchField,
          previousRule:
            was === undefined
              ? null
              : { categoryId: was.setCategoryId, flow: was.setFlow === "TRANSFER" ? ("TRANSFER" as const) : null },
        };
      }),
      restore: [...confirmed, ...reapplied.restore],
    },
  };
}

/**
 * Reverse the last review decision, one payee's or a whole batch's. Deleting
 * the rules is not enough on its own — rules only write to rows they match, so
 * the rows they already categorized would keep their new category with
 * nothing left to explain it. The row writes live in `restoreTransactions`
 * (rulePack.ts) so the tests pin the exact write the action performs — three
 * fields, never the trip tag.
 */
export async function undoCategorizeGroup(undo: GroupUndo): Promise<void> {
  await requireSession();
  // The snapshot arrives from the client: keep only well-formed rule entries.
  const rules = (Array.isArray(undo?.rules) ? undo.rules : []).filter(
    (r) => (r.matchField === "MERCHANT" || r.matchField === "DESCRIPTION") && typeof r.matchValue === "string" && r.matchValue !== "",
  );
  if (rules.length > 0) {
    const stored = new Map((await prisma.rule.findMany({ where: ruleIdentities(rules) })).map((r) => [ruleKey(r), r]));
    const toDelete = rules.filter((r) => r.previousRule === null).flatMap((r) => stored.get(ruleKey(r))?.id ?? []);
    if (toDelete.length > 0) await prisma.rule.deleteMany({ where: { id: { in: toDelete } } });
    for (const r of rules) {
      const rule = stored.get(ruleKey(r));
      if (rule === undefined || r.previousRule === null) continue;
      await prisma.rule.update({
        where: { id: rule.id },
        data: { setCategoryId: r.previousRule.categoryId, setFlow: r.previousRule.flow },
      });
    }
  }
  const restore = Array.isArray(undo?.restore) ? undo.restore : [];
  await restoreTransactions(prisma, restore);
  await regenerateForRows(prisma, { id: { in: restore.map((r) => r.id).filter((id) => typeof id === "string") } });
  revalidatePath("/transactions");
  revalidateInsightPages();
}

/**
 * Tag (or untag, with null) a transaction into a trip/project group.
 *
 * A group is a cross-period VIEW over real rows, never a re-bucketing:
 * category, flow and every analytic stay exactly as they were, so this
 * deliberately does NOT regenerate insights — no analyzer reads `groupLabel`,
 * and the invariant test pins that regeneration after tagging changes nothing.
 */
export async function setTransactionGroup(
  transactionId: string,
  label: string | null,
): Promise<ActionResult> {
  await requireSession();
  const value = label === null ? null : normalizeGroupLabel(label);
  if (label !== null && value === null) {
    // normalizeGroupLabel nulls both the empty and the overlong; tell them apart.
    return refuse(
      label.trim() === ""
        ? "A trip needs a name, or untag the row instead."
        : `Trip names cap at ${MAX_GROUP_LABEL} characters.`,
    );
  }
  await prisma.transaction.update({
    where: { id: transactionId },
    data: { groupLabel: value },
  });
  revalidatePath("/transactions");
  revalidatePath("/insights"); // the TRIPS section reads the tags directly
  return { ok: true };
}

/**
 * Rename a trip across the WHOLE group — every row carrying the tag, never
 * the filtered view the operator happens to be standing in (see
 * renameGroupRows for the semantics). A plain rename is reversible by
 * renaming back; a MERGE is not — the partition is gone — which is why the
 * control warns before saving. No insight regeneration: no analyzer reads
 * groupLabel, and the invariant test pins that a rename changes nothing.
 *
 * Returns the label actually written: casing of an existing group is
 * adopted HERE as well as in the client, because the client's label list
 * can be stale against another session, and the write is what must not
 * fork a case-variant. The client navigates to what came back.
 */
export async function renameGroup(
  from: string,
  to: string,
): Promise<ActionResult<{ count: number; label: string }>> {
  await requireSession();
  const source = normalizeGroupLabel(from);
  const typed = normalizeGroupLabel(to);
  if (source === null) return refuse("No trip named to rename.");
  if (typed === null) {
    return refuse(
      to.trim() === ""
        ? "A trip needs a name."
        : `Trip names cap at ${MAX_GROUP_LABEL} characters.`,
    );
  }
  const labelRows = await prisma.transaction.findMany({
    where: { groupLabel: { not: null } },
    distinct: ["groupLabel"],
    select: { groupLabel: true },
  });
  const existing = labelRows
    .map((r) => r.groupLabel)
    .find((l): l is string => l !== null && l !== source && l.toLowerCase() === typed.toLowerCase());
  const target = existing ?? typed;
  const count = await renameGroupRows(prisma, source, target);
  revalidatePath("/transactions");
  revalidatePath("/insights"); // the TRIPS section reads the tags directly
  return { ok: true, count, label: target };
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
): Promise<ActionResult<{ recategorized: number }>> {
  await requireSession();
  const matchValue = merchant.trim().toLowerCase();
  if (matchValue === "") return refuse("Merchant is empty; categorize this transaction manually instead.");
  // Same floor as the grouped review: a CONTAINS rule at user priority outranks
  // the whole pack, so a one- or two-character value is a wrecking ball.
  if (matchValue.length < 3) {
    return refuse(
      `"${matchValue}" is too short to make a rule from; it would match unrelated transactions.`,
    );
  }
  if (matchField !== "MERCHANT" && matchField !== "DESCRIPTION") {
    return refuse("Unknown match field.");
  }
  const { recategorized } = await upsertRules([{ matchValue, matchField, categoryId, setFlow: null }]);
  return { ok: true, recategorized };
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
): Promise<ActionResult<{ recategorized: number; undo: GroupUndo }>> {
  return categorizeGroups([{ matchValue, matchField, target }]);
}

/** One payee's decision in the grouped review. */
export interface GroupDecision {
  matchValue: string;
  matchField: "MERCHANT" | "DESCRIPTION";
  /** A category id, or TRANSFER_TARGET to mark the payee as a transfer. */
  target: string;
}

/** A batch past this is not a review: refuse it rather than hold a request open. */
const MAX_GROUP_DECISIONS = 500;

/**
 * Resolve many payees at once ("apply all" in the grouped review): every
 * decision is checked exactly as a single one is, and if any fails, nothing is
 * written and the refusal names the payee. The rules are written together and
 * the stored rows re-read ONCE, not once per payee, because on Turso each
 * pass is a round trip over the whole table.
 */
export async function categorizeGroups(
  decisions: GroupDecision[],
): Promise<ActionResult<{ recategorized: number; undo: GroupUndo }>> {
  await requireSession();
  if (!Array.isArray(decisions) || decisions.length === 0) return refuse("Pick a category first.");
  if (decisions.length > MAX_GROUP_DECISIONS) {
    return refuse(`That is ${decisions.length} payees at once; apply at most ${MAX_GROUP_DECISIONS} at a time.`);
  }
  const rules: RuleDecision[] = [];
  for (const d of decisions) {
    const value = String(d.matchValue ?? "").trim().toLowerCase();
    if (value === "") return refuse("Payee is empty; categorize these transactions individually instead.");
    // A CONTAINS rule at user priority outranks the whole pack and is exempt from
    // the P2P guard, so a one- or two-character key is a wrecking ball: a Fidelity
    // dividend on Realty Income normalizes its merchant to the ticker "o", and
    // MERCHANT CONTAINS "o" then recategorizes costco, doordash, every Zelle…
    if (value.length < 3) {
      return refuse(
        `"${value}" is too short to make a rule from; it would match unrelated merchants. Categorize these individually instead.`,
      );
    }
    if (d.matchField !== "MERCHANT" && d.matchField !== "DESCRIPTION") return refuse("Unknown match field.");
    if (typeof d.target !== "string" || d.target === "") return refuse(`Pick a category for "${value}" first.`);
    rules.push(
      d.target === TRANSFER_TARGET
        ? { matchValue: value, matchField: d.matchField, categoryId: null, setFlow: "TRANSFER" }
        : { matchValue: value, matchField: d.matchField, categoryId: d.target, setFlow: null },
    );
  }
  const applied = await upsertRules(rules);
  return { ok: true, ...applied };
}

/**
 * The reimbursement picker's candidate list, computed when it OPENS rather
 * than serialized into every inflow row of the ledger. The page still ranks
 * every inflow at render (the collapsed button's strong-match dot needs it)
 * but ships only that one hint; this action rebuilds the full list for the
 * one inflow whose picker was actually opened. `makeCandidateFinder` is the
 * single projection path for both, so the list this returns is exactly the
 * list the page used to embed — same candidates, same order, same wording
 * (pinned by reimburseCandidates.test.ts).
 */
export async function suggestCandidates(inflowId: string): Promise<ReimburseCandidate[]> {
  await requireSession();
  const window = await reimburseWindow(inflowId);
  if (window === null) return [];
  const { inflow, pool, categoryName } = window;
  const finder = makeCandidateFinder(pool, categoryName);
  return finder({
    amount: Number(inflow.amount),
    date: inflow.date,
    accountType: inflow.account.type,
  });
}

/**
 * The picker's search box: every outflow in the same window whose merchant,
 * description or amount matches, closest in time first — so an expense the
 * ranked suggestions left out can still be linked (searchCandidates).
 */
export async function searchReimbursable(inflowId: string, query: string): Promise<ReimburseCandidate[]> {
  await requireSession();
  const window = await reimburseWindow(inflowId);
  if (window === null) return [];
  const { inflow, pool, categoryName } = window;
  return searchCandidates(pool, categoryName, { amount: Number(inflow.amount), date: inflow.date }, query);
}

/** The inflow and the outflows its picker may offer — shared by suggestion and search. */
async function reimburseWindow(inflowId: string) {
  const inflow = await prisma.transaction.findUniqueOrThrow({
    where: { id: inflowId },
    select: { flow: true, amount: true, date: true, account: { select: { type: true } } },
  });
  if (inflow.flow !== "INFLOW") return null;
  const DAY_MS = 86_400_000;
  const pool = await prisma.transaction.findMany({
    where: {
      flow: "OUTFLOW",
      // Exactly the window suggestReimbursements scores non-zero for this
      // inflow, so narrowing the page's shared pool to one inflow cannot
      // change what it returns.
      date: {
        gte: new Date(inflow.date.getTime() - REIMBURSE_WINDOW_DAYS * DAY_MS),
        lte: new Date(inflow.date.getTime() + REIMBURSE_LEAD_DAYS * DAY_MS),
      },
    },
    select: {
      id: true,
      amount: true,
      date: true,
      categoryId: true,
      normalizedMerchant: true,
      description: true,
    },
    orderBy: [{ date: "desc" }, { id: "desc" }],
    take: REIMBURSE_POOL_TAKE,
  });
  const categories = await prisma.category.findMany({ select: { id: true, name: true } });
  const nameById = new Map(categories.map((c) => [c.id, c.name]));
  return {
    inflow,
    pool: pool.map((o) => ({ ...o, amount: Number(o.amount) })),
    categoryName: (id: string | null) => (id === null ? null : (nameById.get(id) ?? null)),
  };
}

/**
 * Link an inflow to the outflow it pays back. Analytics subtract the
 * amount from the original's category in the original's period, and the
 * inflow stops counting as income.
 */
export async function linkReimbursement(inflowId: string, outflowId: string): Promise<ActionResult> {
  await requireSession();
  const [inflow, outflow] = await Promise.all([
    prisma.transaction.findUniqueOrThrow({ where: { id: inflowId } }),
    prisma.transaction.findUniqueOrThrow({ where: { id: outflowId } }),
  ]);
  // Reachable from a stale page: a sync can pair either row into a transfer
  // after the picker listed it.
  if (inflow.flow !== "INFLOW") {
    return refuse("This payment is no longer money in, so it can't pay back an expense. Reload to see it as it is now.");
  }
  if (outflow.flow !== "OUTFLOW") {
    return refuse("That expense is no longer money out. Reload to see it as it is now.");
  }
  await prisma.transaction.update({
    where: { id: inflowId },
    data: { reimbursesId: outflowId },
  });
  await regenerateForRows(prisma, { id: { in: [inflowId, outflowId] } });
  revalidatePath("/transactions");
  revalidateInsightPages();
  return { ok: true };
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
): Promise<ActionResult> {
  await requireSession();
  if (!CADENCES.has(cadence)) return refuse(`Unknown cadence "${cadence}".`);

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
    return refuse(
      "This row can't be tracked: a subscription needs an outflow with a merchant name of at least three characters.",
    );
  }

  // Re-registering the same merchant updates it rather than listing it twice,
  // the same shape `upsertRules` uses — the pattern is the identity.
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
  return { ok: true };
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
  // Read first: once the link is cut the repaid expense is no longer known.
  const linked = await prisma.transaction.findUnique({ where: { id: inflowId }, select: { reimbursesId: true } });
  await prisma.transaction.update({
    where: { id: inflowId },
    data: { reimbursesId: null },
  });
  await regenerateForRows(prisma, {
    id: { in: linked?.reimbursesId == null ? [inflowId] : [inflowId, linked.reimbursesId] },
  });
  revalidatePath("/transactions");
  revalidateInsightPages();
}
