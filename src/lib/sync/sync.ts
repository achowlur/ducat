import type { Connector, PeriodGranularity } from '../../types/contracts';
import type { Account, PrismaClient } from '../../generated/prisma/client';
import { generateInsights, type GenerateResult } from '../insights/engine';
import { refreshMortgageRate } from '../rates/mortgageRate';
import { applyRules, toRuleTxns } from './rules';
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
 */
export async function runSync(
  prisma: PrismaClient,
  connector: Connector,
  options: SyncOptions = {},
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
  let since = options.since ?? null;
  if (since === null) {
    const lastSync = await prisma.setting.findUnique({ where: { key: lastSyncKey(connector.type) } });
    since = lastSync === null
      ? new Date(Date.now() - 90 * DAY_MS)
      // Overlap the previous sync window: reimporting is free (dedupe),
      // missing late-posted transactions is not.
      : new Date(new Date(lastSync.value).getTime() - 7 * DAY_MS);
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
    })),
  });

  // Category rules over the freshly imported transactions only.
  const ruleRows = await prisma.rule.findMany({ where: { enabled: true } });
  let rulesApplied = 0;
  if (ruleRows.length > 0 && fresh.length > 0) {
    const freshRows = await prisma.transaction.findMany({
      where: {
        externalId: { in: fresh.map((t) => t.externalId) },
        accountId: { in: [...accountIdByExternalId.values()] },
      },
      include: { account: true },
    });
    const applications = applyRules(ruleRows, toRuleTxns(freshRows));
    for (const app of applications) {
      await prisma.transaction.update({
        where: { id: app.txnId },
        data: {
          categoryId: app.categoryId,
          categorySource: 'RULE',
          ...(app.flow === null ? {} : { flow: app.flow }),
        },
      });
    }
    rulesApplied = applications.length;
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
    where: {
      date: { gte: transferScanStart },
      transferPairId: null,
      flow: { not: 'TRANSFER' },
      categorySource: { not: 'MANUAL' },
    },
    select: { id: true, accountId: true, date: true, amount: true, transferPairId: true },
  });
  const pairs = detectTransferPairs(
    candidates.map((t) => ({ ...t, amount: Number(t.amount) })),
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
    transfersLinked: pairs.length,
    feedWarnings: connector.feedWarnings?.() ?? [],
    insights,
  };
}
