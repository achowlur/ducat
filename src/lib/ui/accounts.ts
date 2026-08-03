import { prisma } from "../prisma";
import { DEFAULT_HEALTH_OPTIONS } from "../health/health";
import { countsAsCash, readCashAccountIds } from "./liquidity";
import { isoDate } from "./format";

export interface AccountDetail {
  id: string;
  name: string;
  institution: string;
  connectorType: string;
  type: string;
  currency: string;
  balance: number;
  balanceDate: string;
  daysSinceBalance: number;
  /**
   * How far behind this balance already was AT THE LAST SYNC — the same
   * measurement Overview's "Nd behind" column makes, and for the same reason.
   * Measured against now instead, it says the sync's problem in the row's
   * voice: the day a sync is late every balance is late, so all eight rows
   * raise a chip that blames the feed. What a row can say that a header
   * cannot is "the sync ran and this account did not move".
   *
   * Zero when nothing has ever synced successfully, which is honest — there
   * is no sync to be behind.
   */
  balanceLagDays: number;
  /** Connector said the balance is unknown (e.g. CSV without a balance column). */
  balanceUnknown: boolean;
  /**
   * Counted as spendable cash by the `cash.additionalAccountIds` Setting.
   * Surfaced HERE in particular because this is the page offering a type
   * dropdown, and retyping the account is the documented wrong fix
   * (liquidity.ts) — the override has to be visible next to the control that
   * invites breaking it.
   */
  isCash: boolean;
  /** Balance date older than the health threshold — the quiet-failure smell. */
  staleByAge: boolean;
  txnCount: number;
  firstTxnDate: string | null;
  lastTxnDate: string | null;
  snapshotCount: number;
  latestSnapshotDate: string | null;
  /** Last 12 snapshot balances, oldest first — sparkline input. */
  snapshotSeries: number[];
}

export interface AccountsPageData {
  groups: { type: string; label: string; accounts: AccountDetail[] }[];
  totalBalance: number;
}

const DAY_MS = 86_400_000;
const TYPE_LABELS: [type: string, label: string][] = [
  ["DEPOSITORY", "Depository"],
  ["INVESTMENT", "Investment"],
  ["CREDIT", "Credit"],
  ["LOAN", "Loan"],
];

export async function getAccountsData(now: Date = new Date()): Promise<AccountsPageData> {
  const [accounts, txnStats, snapshots, lastSync, cashAccountIds] = await Promise.all([
    prisma.account.findMany(),
    prisma.transaction.groupBy({
      by: ["accountId"],
      _count: { _all: true },
      _min: { date: true },
      _max: { date: true },
    }),
    prisma.balanceSnapshot.findMany({ orderBy: { date: "asc" } }),
    // Joins the existing Promise.all, so the anchor for every row's lag costs
    // no latency. Deliberately the same query Overview makes — the two pages
    // print the same fact and must not derive it from different clocks.
    prisma.syncLog.findFirst({ where: { ok: true }, orderBy: { finishedAt: "desc" } }),
    readCashAccountIds(prisma),
  ]);
  const syncedAt = lastSync?.finishedAt?.getTime() ?? null;

  const statsByAccount = new Map(txnStats.map((s) => [s.accountId, s]));
  const snapshotsByAccount = new Map<string, { date: Date; balance: number }[]>();
  for (const s of snapshots) {
    const list = snapshotsByAccount.get(s.accountId) ?? [];
    list.push({ date: s.date, balance: Number(s.balance) });
    snapshotsByAccount.set(s.accountId, list);
  }

  const details: AccountDetail[] = accounts.map((a) => {
    const stats = statsByAccount.get(a.id);
    const snaps = snapshotsByAccount.get(a.id) ?? [];
    const daysSinceBalance = Math.floor((now.getTime() - a.balanceDate.getTime()) / DAY_MS);
    return {
      id: a.id,
      name: a.name,
      institution: a.institution,
      connectorType: a.connectorType,
      type: a.type,
      currency: a.currency,
      balance: Number(a.balance),
      balanceDate: isoDate(a.balanceDate),
      daysSinceBalance,
      balanceLagDays:
        syncedAt === null ? 0 : Math.max(0, Math.floor((syncedAt - a.balanceDate.getTime()) / DAY_MS)),
      balanceUnknown: a.isStale,
      isCash: countsAsCash({ id: a.id, type: a.type, balance: Number(a.balance) }, cashAccountIds),
      staleByAge: daysSinceBalance > DEFAULT_HEALTH_OPTIONS.staleBalanceDays,
      txnCount: stats?._count._all ?? 0,
      firstTxnDate: stats?._min.date === null || stats === undefined ? null : isoDate(stats._min.date),
      lastTxnDate: stats?._max.date === null || stats === undefined ? null : isoDate(stats._max.date),
      snapshotCount: snaps.length,
      latestSnapshotDate: snaps.length === 0 ? null : isoDate(snaps[snaps.length - 1].date),
      snapshotSeries: snaps.slice(-12).map((s) => s.balance),
    };
  });

  const groups = TYPE_LABELS.map(([type, label]) => ({
    type,
    label,
    accounts: details
      .filter((d) => d.type === type)
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)),
  })).filter((g) => g.accounts.length > 0);

  return {
    groups,
    totalBalance: details.reduce((sum, d) => sum + d.balance, 0),
  };
}
