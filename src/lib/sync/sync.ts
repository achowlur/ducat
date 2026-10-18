import type { Connector, PeriodGranularity, TransactionFlow } from '../../types/contracts';
import type { Account, PrismaClient } from '../../generated/prisma/client';
import { generateInsights, type GenerateResult } from '../insights/engine';
import { refreshMortgageRate } from '../rates/mortgageRate';
import { shortDateYear } from '../ui/format';
import { CLOSED_BOX_RULE_ID, crossesTheBoundary } from './closedBox';
import { claimSyncLock, releaseSyncLock } from './lock';
import { applyRules, toRuleTxns } from './rules';
import { sourceCategoryToApply } from './sourceCategory';
import { detectTransferPairs } from './transfers';

export interface SyncOptions {
  /** Fetch transactions from this date; default: last sync minus 7-day overlap, or 90 days back. */
  since?: Date;
  granularity?: PeriodGranularity;
  /** Skip insight regeneration (e.g. batching several CSV imports). */
  skipInsights?: boolean;
}

export interface SyncResult {
  connectorType: string;
  since: Date;
  accountsCreated: number;
  accountsUpdated: number;
  snapshotsWritten: number;
  transactionsImported: number;
  transactionsSkipped: number;
  rulesApplied: number;
  /** Rows given the category their source assigned (a card export's), where no rule matched. */
  sourceCategorized: number;
  transfersLinked: number;
  feedWarnings: string[];
  insights: GenerateResult | null;
}

const DAY_MS = 86_400_000;

function lastSyncKey(connectorType: string): string {
  return `lastSync:${connectorType}`;
}

/**
 * The account a normalized one would land in: this connector's own if it has
 * one, otherwise ANY account carrying that externalId.
 *
 * The externalId-only fallback is what lets a CSV backfill fill in an account a
 * live connector already owns instead of forking a second copy of the same
 * real-world account — externalIds are connector-issued ids or user-chosen
 * slugs, so a cross-connector match is deliberate.
 *
 * Exported because `previewImport` has to answer "create, or land in what is
 * already there?" with the SAME lookup. A preview holding its own copy would
 * get the backfill case backwards — announcing a new account for precisely the
 * invocation the dry run exists to check.
 */
export async function findExistingAccount(
  prisma: PrismaClient,
  externalId: string,
  connectorType: string,
): Promise<Account | null> {
  return (
    (await prisma.account.findFirst({ where: { externalId, connectorType } })) ??
    (await prisma.account.findFirst({ where: { externalId } }))
  );
}

/** Dedupe identity of a stored transaction: the (accountId, externalId) unique. */
export function transactionKey(accountId: string, externalId: string): string {
  return `${accountId}|${externalId}`;
}

/**
 * Which of these (accountId, externalId) pairs the database already holds.
 * Shared with the preview for the same reason as the lookup above: "how many of
 * these rows are already here" is the question a dry run exists to answer, and
 * a second copy of the key format would answer it differently.
 */
export async function existingTransactionKeys(
  prisma: PrismaClient,
  accountIds: string[],
  externalIds: string[],
): Promise<Set<string>> {
  const rows = await prisma.transaction.findMany({
    where: { accountId: { in: accountIds }, externalId: { in: externalIds } },
    select: { accountId: true, externalId: true },
  });
  return new Set(rows.map((t) => transactionKey(t.accountId, t.externalId)));
}

/**
 * Full sync pipeline: fetch → upsert accounts → snapshot balances →
 * import new transactions → apply category rules → link transfer pairs →
 * regenerate insights → record sync time. Every run — success or failure —
 * is persisted to SyncLog; the health panel reads that history.
 *
 * One run at a time (lock.ts): a second one throws SyncAlreadyRunningError
 * BEFORE it starts, so it writes no SyncLog. It never ran, and health must not
 * show it as a sync that broke.
 */
export async function runSync(
  prisma: PrismaClient,
  connector: Connector,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const claim = await claimSyncLock(prisma);
  try {
    return await loggedPipeline(prisma, connector, options);
  } finally {
    await releaseSyncLock(prisma, claim);
  }
}

async function loggedPipeline(
  prisma: PrismaClient,
  connector: Connector,
  options: SyncOptions,
): Promise<SyncResult> {
  const startedAt = new Date();
  try {
    const result = await runPipeline(prisma, connector, options);
    await prisma.syncLog.create({
      data: {
        connectorType: connector.type,
        startedAt,
        finishedAt: new Date(),
        ok: true,
        feedErrors: result.feedWarnings,
        accountsSeen: result.accountsCreated + result.accountsUpdated,
        transactionsImported: result.transactionsImported,
        transactionsSkipped: result.transactionsSkipped,
        rulesApplied: result.rulesApplied,
        transfersLinked: result.transfersLinked,
      },
    });
    return result;
  } catch (e) {
    await prisma.syncLog.create({
      data: {
        connectorType: connector.type,
        startedAt,
        finishedAt: new Date(),
        ok: false,
        errorText: e instanceof Error ? e.message : String(e),
        feedErrors: connector.feedWarnings?.() ?? [],
        accountsSeen: 0,
        transactionsImported: 0,
        transactionsSkipped: 0,
        rulesApplied: 0,
        transfersLinked: 0,
      },
    });
    throw e;
  }
}

async function runPipeline(
  prisma: PrismaClient,
  connector: Connector,
  options: SyncOptions,
): Promise<SyncResult> {
  // One clock for the default window and the feed's reach, or a first sync
  // would sit a few milliseconds past its own feed and warn about nothing.
  const now = Date.now();
  let since = options.since ?? null;
  if (since === null) {
    const lastSync = await prisma.setting.findUnique({ where: { key: lastSyncKey(connector.type) } });
    since = lastSync === null
      ? new Date(now - 90 * DAY_MS)
      // Overlap the previous sync window: reimporting is free (dedupe),
      // missing late-posted transactions is not.
      : new Date(new Date(lastSync.value).getTime() - 7 * DAY_MS);
  }

  // A feed that keeps only so much history narrows a longer window itself,
  // without a word: a gap of months (a token that lapsed, an instance left
  // off) would lose its oldest rows and every total would quietly read low.
  // Ask only for what the feed holds and name what it could not give.
  const warnings: string[] = [];
  if (connector.maxHistoryDays !== undefined) {
    const reach = new Date(now - connector.maxHistoryDays * DAY_MS);
    if (since < reach) {
      warnings.push(
        `Transactions from ${shortDateYear(since)} until ${shortDateYear(reach)} could not be fetched: ` +
          `the feed reaches back only ${connector.maxHistoryDays} days. Import a CSV for that span.`,
      );
      since = reach;
    }
  }

  const normalizedAccounts = await connector.listAccounts();
  let accountsCreated = 0;
  let accountsUpdated = 0;
  let snapshotsWritten = 0;
  const accountIdByExternalId = new Map<string, string>();

  for (const a of normalizedAccounts) {
    // Pass that account's externalId to the importer and a CSV backfill lands
    // IN it rather than beside it; see findExistingAccount for why the fallback
    // is deliberate.
    const existing = await findExistingAccount(prisma, a.externalId, connector.type);
    let id: string;
    if (existing === null) {
      const created = await prisma.account.create({
        data: {
          externalId: a.externalId,
          connectorType: a.connectorType,
          institution: a.institution,
          name: a.name,
          type: a.type,
          currency: a.currency,
          balance: a.balance,
          balanceDate: a.balanceDate,
          isStale: a.isStale,
        },
      });
      id = created.id;
      accountsCreated++;
    } else {
      // type intentionally not updated: inference only guesses at creation;
      // a manual correction must survive re-syncs.
      //
      // Two things weaker data must never clobber:
      //  - identity, when writing into an account another connector owns (a
      //    CSV backfill shouldn't rename the live account it's filling in);
      //  - the balance, when the feed has none. A CSV export without a
      //    running-balance column reports 0/isStale, which would otherwise
      //    overwrite a good balance with zero and wreck net worth.
      const foreign = existing.connectorType !== connector.type;
      await prisma.account.update({
        where: { id: existing.id },
        data: {
          ...(foreign ? {} : { institution: a.institution, name: a.name, currency: a.currency }),
          ...(a.isStale ? {} : { balance: a.balance, balanceDate: a.balanceDate, isStale: false }),
        },
      });
      id = existing.id;
      accountsUpdated++;
    }
    accountIdByExternalId.set(a.externalId, id);

    if (!a.isStale) {
      await prisma.balanceSnapshot.upsert({
        where: { accountId_date: { accountId: id, date: a.balanceDate } },
        create: { accountId: id, date: a.balanceDate, balance: a.balance },
        update: { balance: a.balance },
      });
      snapshotsWritten++;
    }
  }

  const fetched = await connector.fetchTransactions(since);
  const mappable = fetched.filter((t) => accountIdByExternalId.has(t.accountExternalId));
  const existingIds = await existingTransactionKeys(
    prisma,
    [...accountIdByExternalId.values()],
    mappable.map((t) => t.externalId),
  );
  const fresh = mappable.filter(
    (t) =>
      !existingIds.has(
        transactionKey(accountIdByExternalId.get(t.accountExternalId) as string, t.externalId),
      ),
  );

  await prisma.transaction.createMany({
    data: fresh.map((t) => ({
      accountId: accountIdByExternalId.get(t.accountExternalId) as string,
      externalId: t.externalId,
      date: t.date,
      amount: t.amount,
      description: t.description,
      normalizedMerchant: t.normalizedMerchant,
      flow: t.flow,
      categorySource: 'AGGREGATOR' as const,
      source: t.source,
      importBatchId: t.importBatchId ?? null,
    })),
  });

  // Category rules over every row still waiting for them: this run's fresh
  // rows, and any a run killed between its insert and this step left behind.
  // Those are stored, so the next run's dedupe never calls them fresh, and
  // without this they stayed uncategorized for good. "Waiting" is what an
  // insert leaves: AGGREGATOR, no category, no transfer pair. MANUAL is never
  // in reach; a pair's category was cleared on purpose by its detection.
  // Not gated on there BEING rules: a row inside an investment account is
  // classified by its account's type (closedBox.ts), which needs none.
  const ruleRows = await prisma.rule.findMany({ where: { enabled: true } });
  let rulesApplied = 0;
  let sourceCategorized = 0;
  const waitingRows = await prisma.transaction.findMany({
    where: { categorySource: 'AGGREGATOR', categoryId: null, transferPairId: null },
    select: {
      id: true,
      accountId: true,
      externalId: true,
      amount: true,
      description: true,
      normalizedMerchant: true,
      flow: true,
      categorySource: true,
      account: { select: { name: true, type: true } },
    },
  });
  if (waitingRows.length > 0) {
    // One write per outcome, not per row: the per-row loop is the step a 60s
    // limit cut short. The MANUAL guard is repeated in the write because the
    // operator can categorize a row between the read above and here.
    //
    // A row stored earlier that the closed box would leave as it is (already a
    // transfer, no category) is skipped, as reapplyRules skips it: the box
    // changes nothing there, and writing it would only relabel its source.
    const freshKeys = new Set(
      fresh.map((t) => transactionKey(accountIdByExternalId.get(t.accountExternalId) as string, t.externalId)),
    );
    const waitingById = new Map(waitingRows.map((r) => [r.id, r]));
    const applications = applyRules(ruleRows, toRuleTxns(waitingRows)).filter((app) => {
      const row = waitingById.get(app.txnId);
      if (row === undefined || app.ruleId !== CLOSED_BOX_RULE_ID) return true;
      return row.flow !== 'TRANSFER' || freshKeys.has(transactionKey(row.accountId, row.externalId));
    });
    const byOutcome = new Map<string, { categoryId: string | null; flow: TransactionFlow | null; ids: string[] }>();
    for (const app of applications) {
      const key = `${app.categoryId ?? ''}|${app.flow ?? ''}`;
      const group = byOutcome.get(key) ?? { categoryId: app.categoryId, flow: app.flow, ids: [] };
      group.ids.push(app.txnId);
      byOutcome.set(key, group);
    }
    for (const { categoryId, flow, ids } of byOutcome.values()) {
      await prisma.transaction.updateMany({
        where: { id: { in: ids }, categorySource: { not: 'MANUAL' } },
        data: { categoryId, categorySource: 'RULE', ...(flow === null ? {} : { flow }) },
      });
    }
    rulesApplied = applications.length;

    // Then the source's own category (a card export's), on rows no rule spoke
    // for. It stays an AGGREGATOR category: a rule made or reapplied later
    // still outranks it, and the operator's MANUAL choice is never in reach,
    // as no waiting row carries one. Rows headed for one category go together.
    // The hint travels with the feed's row and is not stored, so a stranded
    // row gets it back only while it is still inside the window fetched.
    const ruled = new Set(applications.map((a) => a.txnId));
    const hinted = new Map(
      mappable
        .filter((t) => t.sourceCategory !== undefined)
        .map((t) => [`${accountIdByExternalId.get(t.accountExternalId)}|${t.externalId}`, t.sourceCategory as string]),
    );
    if (hinted.size > 0) {
      const categoryIdByName = new Map(
        (await prisma.category.findMany({ select: { id: true, name: true } })).map((c) => [c.name, c.id]),
      );
      const byCategory = new Map<string, string[]>();
      for (const row of waitingRows) {
        const name = sourceCategoryToApply(
          { ...row, sourceCategory: hinted.get(`${row.accountId}|${row.externalId}`) },
          row.account.type,
          ruled.has(row.id),
        );
        const categoryId = name === null ? undefined : categoryIdByName.get(name);
        if (categoryId === undefined) continue;
        byCategory.set(categoryId, [...(byCategory.get(categoryId) ?? []), row.id]);
      }
      for (const [categoryId, ids] of byCategory) {
        await prisma.transaction.updateMany({ where: { id: { in: ids }, categorySource: { not: 'MANUAL' } }, data: { categoryId } });
        sourceCategorized += ids.length;
      }
    }
  }

  // Transfer detection spans ALL accounts (a transfer's two sides usually
  // come from different connectors/syncs), over a window generous enough
  // to catch counterparts of everything just imported.
  const transferScanStart = new Date(since.getTime() - 7 * DAY_MS);
  const candidates = await prisma.transaction.findMany({
    // MANUAL rows are excluded: pairing rewrites flow to TRANSFER and clears
    // the category, which would silently delete a human's decision and drop
    // the expense from every spending total. A $139.95 dinner you categorized and
    // a $139.95 repayment two days later look exactly like a transfer pair.
    //
    // A row inside an investment account is a transfer ALREADY, by its
    // account's type, and must still be offered when it could be one side of
    // a deposit or a withdrawal. Left out, the bank's side of a brokerage
    // deposit pairs with nothing and is counted as spending, and which of the
    // two rows arrived first would decide it. What stays inside the account
    // (a sale, a dividend, a sweep) is not offered: see crossesTheBoundary.
    where: {
      date: { gte: transferScanStart },
      transferPairId: null,
      categorySource: { not: 'MANUAL' },
      OR: [{ flow: { not: 'TRANSFER' } }, { account: { type: 'INVESTMENT' } }],
    },
    select: {
      id: true,
      accountId: true,
      date: true,
      amount: true,
      transferPairId: true,
      flow: true,
      description: true,
    },
  });
  const pairs = detectTransferPairs(
    candidates
      .filter((t) => t.flow !== 'TRANSFER' || crossesTheBoundary(t.description))
      .map((t) => ({
        id: t.id,
        accountId: t.accountId,
        date: t.date,
        amount: Number(t.amount),
        transferPairId: t.transferPairId,
      })),
  );
  for (const pair of pairs) {
    await prisma.transaction.update({
      where: { id: pair.outId },
      data: { flow: 'TRANSFER', transferPairId: pair.inId, categoryId: null },
    });
    await prisma.transaction.update({
      where: { id: pair.inId },
      data: { flow: 'TRANSFER', transferPairId: pair.outId, categoryId: null },
    });
  }

  // The mortgage-rate observation rides the sync — never launch, never render
  // (the read-only-external-fetch shape in sync-and-data-ops.md). It runs just
  // BEFORE insight regeneration so everything downstream of the store reads
  // the fresh observation, and it skips when insights do: a batched CSV
  // import's final pass fetches once instead of once per file. Opt-in via
  // FRED_API_KEY (absent means no network call at all), and never allowed to
  // fail the sync — refreshMortgageRate records its own failures in the
  // Setting it owns and keeps the last good observation standing.
  let insights: GenerateResult | null = null;
  if (options.skipInsights !== true) {
    await refreshMortgageRate(prisma);
    insights = await generateInsights(prisma, { granularity: options.granularity });
  }

  await prisma.setting.upsert({
    where: { key: lastSyncKey(connector.type) },
    create: { key: lastSyncKey(connector.type), value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });

  return {
    connectorType: connector.type,
    since,
    accountsCreated,
    accountsUpdated,
    snapshotsWritten,
    transactionsImported: fresh.length,
    transactionsSkipped: mappable.length - fresh.length,
    rulesApplied,
    sourceCategorized,
    transfersLinked: pairs.length,
    feedWarnings: [...warnings, ...(connector.feedWarnings?.() ?? [])],
    insights,
  };
}
