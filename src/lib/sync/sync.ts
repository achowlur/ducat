import type { Connector, PeriodGranularity } from '../../types/contracts';
import type { PrismaClient } from '../../generated/prisma/client';
import { generateInsights, type GenerateResult } from '../insights/engine';
import { applyRules, type RuleTxn } from './rules';
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
  insights: GenerateResult | null;
}

const DAY_MS = 86_400_000;

function lastSyncKey(connectorType: string): string {
  return `lastSync:${connectorType}`;
}

/**
 * Full sync pipeline: fetch → upsert accounts → snapshot balances →
 * import new transactions → apply category rules → link transfer pairs →
 * regenerate insights → record sync time.
 */
export async function runSync(
  prisma: PrismaClient,
  connector: Connector,
  options: SyncOptions = {},
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
    const existing = await prisma.account.findFirst({
      where: { externalId: a.externalId, connectorType: connector.type },
    });
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
      await prisma.account.update({
        where: { id: existing.id },
        data: {
          institution: a.institution,
          name: a.name,
          currency: a.currency,
          balance: a.balance,
          balanceDate: a.balanceDate,
          isStale: a.isStale,
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
  const existingIds = new Set(
    (
      await prisma.transaction.findMany({
        where: {
          accountId: { in: [...accountIdByExternalId.values()] },
          externalId: { in: mappable.map((t) => t.externalId) },
        },
        select: { accountId: true, externalId: true },
      })
    ).map((t) => `${t.accountId}|${t.externalId}`),
  );
  const fresh = mappable.filter(
    (t) => !existingIds.has(`${accountIdByExternalId.get(t.accountExternalId) as string}|${t.externalId}`),
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
    const ruleTxns: RuleTxn[] = freshRows.map((t) => ({
      id: t.id,
      amount: Number(t.amount),
      description: t.description,
      normalizedMerchant: t.normalizedMerchant,
      accountName: t.account.name,
      categorySource: t.categorySource,
    }));
    const applications = applyRules(
      ruleRows.map((r) => ({
        id: r.id,
        priority: r.priority,
        matchField: r.matchField,
        matchOperator: r.matchOperator,
        matchValue: r.matchValue,
        setCategoryId: r.setCategoryId,
        setFlow: r.setFlow,
        enabled: r.enabled,
      })),
      ruleTxns,
    );
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
    where: { date: { gte: transferScanStart }, transferPairId: null, flow: { not: 'TRANSFER' } },
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

  const insights = options.skipInsights === true
    ? null
    : await generateInsights(prisma, { granularity: options.granularity });

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
    insights,
  };
}
