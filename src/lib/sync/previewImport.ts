import type { Connector, TransactionFlow } from '../../types/contracts';
import type { PrismaClient } from '../../generated/prisma/client';
import { groupByPayee, type GroupTxn, type PayeeGroup } from './grouping';
import { applyRules, type RuleTxn } from './rules';
import { existingTransactionKeys, findExistingAccount, transactionKey } from './sync';

/**
 * What an import WOULD do, computed without writing a row.
 *
 * A READ-ONLY BRANCH of the path that writes, never a second implementation of
 * it: the connector is the same object `runSync` would be handed, the account
 * lookup and the dedupe key are `sync.ts`'s own exports, and the rule matcher
 * and the payee grouper are the same pure functions the pipeline and the
 * review queue call. What is left here is the ORDER and the counting, and
 * `previewImport.test.ts` pins those against a real `runSync` over the same
 * fixture — if the two ever disagree about how many rows land, how many are
 * already present, or how many rules fire, that test fails rather than the
 * operator finding out afterwards.
 *
 * What it deliberately does NOT answer, because it cannot without writing:
 * transfer-pair linking (both sides are matched against rows this import has
 * not created) and insight regeneration. The caller says so out loud rather
 * than letting silence read as "nothing would happen".
 */

/** What the import would do to one account's stored balance. */
export interface BalancePlan {
  /** False when the connector reports `isStale` — a capped import, or an export with no running-balance column. */
  writes: boolean;
  value: number | null;
  date: Date | null;
  /** What the account carries today, when it exists already. */
  currentValue: number | null;
  currentDate: Date | null;
  /**
   * The write would date the balance EARLIER than the one already stored —
   * the shape a backfill takes when `--until` was forgotten.
   */
  movesBackward: boolean;
  /** A BalanceSnapshot would be upserted at `date` (same condition as the balance write). */
  snapshot: boolean;
}

export interface AccountPlan {
  externalId: string;
  /** The name rows would be filed under: the LIVE one when adopting, since the import never renames a foreign account. */
  name: string;
  institution: string;
  /** CREATE: no such account. UPDATE: this connector's own. ADOPT: another connector owns it (a backfill). */
  disposition: 'CREATE' | 'UPDATE' | 'ADOPT';
  /** The connectorType of the account already there, when there is one. */
  ownedBy: string | null;
  /** Rows the connector routed here, after its own `--until` cap. */
  rows: number;
  newRows: number;
  duplicateRows: number;
  firstDate: Date | null;
  lastDate: Date | null;
  balance: BalancePlan;
}

/** Merchant strings the import would introduce — the review pile's raw material. */
export interface MerchantPlan {
  /** Distinct `normalizedMerchant` values across the rows that would land. */
  distinct: number;
  /** Of those, values no stored transaction carries yet. */
  unseen: number;
  /** Of the unseen, values that would appear on exactly ONE row — the shattering signature. */
  unseenSingletons: number;
}

/** A grouped-review decision the import would add. Ids are omitted: the rows do not exist yet. */
export type PayeeDecision = Omit<PayeeGroup, 'transactionIds'>;

export interface ImportPreview {
  connectorType: string;
  since: Date;
  /** Rows the connector offered for the window. */
  fetchedRows: number;
  /** Of those, rows belonging to an account the connector also listed. */
  mappedRows: number;
  newRows: number;
  duplicateRows: number;
  accounts: AccountPlan[];
  /** Rule applications, counted the way `SyncResult.rulesApplied` counts them (flow-only rules included). */
  rulesApplied: number;
  /** Rows a rule would give a category to. */
  categorized: number;
  /** Rows that would reach the grouped review: no category, not a transfer. */
  reviewRows: number;
  /**
   * The decisions those rows group into, highest-leverage first. An UPPER
   * BOUND: transfer-pair detection is not previewed, and every pair it finds
   * takes two rows out of this queue.
   */
  decisions: PayeeDecision[];
  /** Of `decisions`, keys that join a group already waiting in the queue rather than adding one. */
  decisionsJoiningExisting: number;
  merchants: MerchantPlan;
}

export async function previewImport(
  prisma: PrismaClient,
  connector: Connector,
  since: Date,
): Promise<ImportPreview> {
  const normalizedAccounts = await connector.listAccounts();

  const accountPlans = new Map<string, AccountPlan>();
  const existingIdByExternalId = new Map<string, string>();
  for (const a of normalizedAccounts) {
    const existing = await findExistingAccount(prisma, a.externalId, connector.type);
    if (existing !== null) existingIdByExternalId.set(a.externalId, existing.id);
    // Identity is not rewritten on a foreign account, so its stored name is
    // both what the ledger will show and what an ACCOUNT rule matches on.
    const foreign = existing !== null && existing.connectorType !== connector.type;
    const currentDate = existing === null ? null : existing.balanceDate;
    accountPlans.set(a.externalId, {
      externalId: a.externalId,
      name: existing !== null && foreign ? existing.name : a.name,
      institution: existing !== null && foreign ? existing.institution : a.institution,
      disposition: existing === null ? 'CREATE' : foreign ? 'ADOPT' : 'UPDATE',
      ownedBy: existing === null ? null : existing.connectorType,
      rows: 0,
      newRows: 0,
      duplicateRows: 0,
      firstDate: null,
      lastDate: null,
      balance: {
        writes: !a.isStale,
        value: a.isStale ? null : a.balance,
        date: a.isStale ? null : a.balanceDate,
        currentValue: existing === null ? null : Number(existing.balance),
        currentDate,
        movesBackward:
          !a.isStale && currentDate !== null && a.balanceDate.getTime() < currentDate.getTime(),
        snapshot: !a.isStale,
      },
    });
  }

  const fetched = await connector.fetchTransactions(since);
  const mappable = fetched.filter((t) => accountPlans.has(t.accountExternalId));

  // Only accounts that EXIST can hold a duplicate; rows bound for an account
  // this import would create are new by construction.
  const existingIds = [...existingIdByExternalId.values()];
  const present =
    existingIds.length === 0 || mappable.length === 0
      ? new Set<string>()
      : await existingTransactionKeys(
          prisma,
          existingIds,
          mappable.map((t) => t.externalId),
        );

  const fresh: typeof mappable = [];
  for (const t of mappable) {
    const plan = accountPlans.get(t.accountExternalId) as AccountPlan;
    plan.rows += 1;
    if (plan.firstDate === null || t.date.getTime() < plan.firstDate.getTime()) plan.firstDate = t.date;
    if (plan.lastDate === null || t.date.getTime() > plan.lastDate.getTime()) plan.lastDate = t.date;
    const accountId = existingIdByExternalId.get(t.accountExternalId);
    if (accountId === undefined || !present.has(transactionKey(accountId, t.externalId))) {
      plan.newRows += 1;
      fresh.push(t);
    } else {
      plan.duplicateRows += 1;
    }
  }

  // The pipeline runs rules over the freshly imported rows only, so the preview
  // does too. The index is the correlation id: a CSV externalId is a content
  // hash that deliberately omits the account, so two accounts can carry the
  // same one and keying by it would conflate them.
  const ruleRows = await prisma.rule.findMany({ where: { enabled: true } });
  const ruleTxns: RuleTxn[] = fresh.map((t, i) => ({
    id: String(i),
    amount: t.amount,
    description: t.description,
    normalizedMerchant: t.normalizedMerchant,
    accountName: (accountPlans.get(t.accountExternalId) as AccountPlan).name,
    categorySource: 'AGGREGATOR',
  }));
  const applications =
    ruleRows.length > 0 && fresh.length > 0 ? applyRules(ruleRows, ruleTxns) : [];
  const appliedByRow = new Map(applications.map((a) => [a.txnId, a]));

  // Exactly the queue /transactions?payees=1 builds: no category, not a
  // transfer, not a reimbursement — the last of which no new row can be.
  const queue: GroupTxn[] = [];
  fresh.forEach((t, i) => {
    const applied = appliedByRow.get(String(i));
    const flow: TransactionFlow = applied?.flow ?? t.flow;
    if (applied !== undefined && applied.categoryId !== null) return;
    if (flow === 'TRANSFER') return;
    queue.push({
      id: String(i),
      amount: t.amount,
      description: t.description,
      normalizedMerchant: t.normalizedMerchant,
      flow,
    });
  });
  // Listed field by field rather than spread: the annotation then makes a new
  // PayeeGroup field a compile error here instead of a silent omission.
  const decisions: PayeeDecision[] = groupByPayee(queue).map((g) => ({
    key: g.key,
    matchField: g.matchField,
    isP2P: g.isP2P,
    count: g.count,
    total: g.total,
    samples: g.samples,
    flow: g.flow,
  }));

  const backlog = await prisma.transaction.findMany({
    where: { categoryId: null, flow: { not: 'TRANSFER' }, reimbursesId: null },
    select: { id: true, amount: true, description: true, normalizedMerchant: true, flow: true },
  });
  const waiting = new Set(
    groupByPayee(backlog.map((t) => ({ ...t, amount: Number(t.amount) }))).map((g) => g.key),
  );

  const merchantCounts = new Map<string, number>();
  for (const t of fresh) {
    merchantCounts.set(t.normalizedMerchant, (merchantCounts.get(t.normalizedMerchant) ?? 0) + 1);
  }
  const distinctMerchants = [...merchantCounts.keys()];
  const storedMerchants =
    distinctMerchants.length === 0
      ? new Set<string>()
      : new Set(
          (
            await prisma.transaction.findMany({
              where: { normalizedMerchant: { in: distinctMerchants } },
              select: { normalizedMerchant: true },
            })
          ).map((t) => t.normalizedMerchant),
        );
  const unseen = distinctMerchants.filter((m) => !storedMerchants.has(m));

  return {
    connectorType: connector.type,
    since,
    fetchedRows: fetched.length,
    mappedRows: mappable.length,
    newRows: fresh.length,
    duplicateRows: mappable.length - fresh.length,
    accounts: [...accountPlans.values()],
    rulesApplied: applications.length,
    categorized: applications.filter((a) => a.categoryId !== null).length,
    reviewRows: queue.length,
    decisions,
    decisionsJoiningExisting: decisions.filter((d) => waiting.has(d.key)).length,
    merchants: {
      distinct: distinctMerchants.length,
      unseen: unseen.length,
      unseenSingletons: unseen.filter((m) => merchantCounts.get(m) === 1).length,
    },
  };
}
