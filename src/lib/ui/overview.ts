/**
 * Overview answers WHERE THINGS STAND: what you hold, what it adds up to, and
 * what needs review. Trajectory — what changed, what it costs forward, what is
 * about to be charged — belongs to /insights, which now has a digest, a pace
 * call and a commitments panel built for exactly that.
 *
 * This page used to carry both. Its "signals" column and its subscriptions
 * block were the same findings the digest ranks, rendered a second way and
 * uncapped, so the two tabs answered one question twice and disagreed on
 * emphasis. The full recurring roster and its annualised total live on
 * /insights now; nothing was dropped.
 */
import type { NetWorthGrowthPayload, SpendingByCategoryPayload } from "../../types/contracts";
import { prisma } from "../prisma";
import { DEFAULT_HEALTH_OPTIONS, getProviderHealth } from "../health/health";
import { pendingPackRules } from "../sync/rulePack";
import type { ProviderHealth } from "../health/types";
import {
  computeRunway,
  countsAsCash,
  readCashAccountIds,
  summariseBalances,
  type BalanceSummary,
  type Runway,
} from "./liquidity";
import { periodKey } from "../insights/periods";
import { monthLabel, shortDate } from "./format";
import { monthlyRows, ofType } from "./insightRows";
import { spendingBreakdown, type DonutSliceData } from "./spendingBreakdown";

export interface AccountRow {
  id: string;
  name: string;
  institution: string;
  type: string;
  balance: number;
  snapshotBacked: boolean;
  snapshotDate: string | null;
  /**
   * How far behind this balance already was when we LAST SYNCED — not how long
   * ago that was. Measured against the sync rather than against now because
   * the two failures are different and only one belongs on a row: if nothing
   * has synced for a week every balance is a week old, which is the sync's
   * problem and the header already says so. What a row can say that the header
   * cannot is "the sync ran and this account did not move", which is exactly
   * how Chase looked while its connection was frozen — fresh everywhere else,
   * four days behind here.
   *
   * Shown from `STALE_DISPLAY_DAYS` up; that is a LEGIBILITY threshold, not a
   * health one. The alarm stays with health's tuned `staleBalanceDays`.
   */
  balanceLagDays: number;
  /** Health has flagged this balance as stale — the tuned threshold, not the display one. */
  stale: boolean;
  /** True when this balance is counted as spendable cash. */
  isCash: boolean;
}

/** Below this the lag is not worth printing; see AccountRow.balanceLagDays. */
export const STALE_DISPLAY_DAYS = 2;

/**
 * The latest COMPLETE month's NET_WORTH_GROWTH figures, carried as labeled
 * context under the live headline — never as the headline itself. Two instants
 * presented as one state was the bug: a July insight figure rendered above
 * today's balances, and the two drifted apart all month.
 */
export interface MonthContext {
  period: string; // "2026-07"
  /** "July 2026" — the label every context line must carry. */
  label: string;
  /** "July" — for prose that names the month mid-sentence. */
  monthName: string;
  growthRate: number | null;
  marketGains: number | null;
  /** Accounts whose balance in THAT month's net worth was reconstructed. */
  estimatedCount: number;
}

export interface OverviewData {
  /**
   * The signed sum of current account balances — the sign convention's own
   * definition of net worth (CREDIT/LOAN negative), read live. No month label
   * belongs on it: it is an instant, not a period.
   */
  liveNetWorth: number;
  /** Null when no complete month has a NET_WORTH_GROWTH row — the live headline stands alone. */
  monthContext: MonthContext | null;
  /** The month being lived in ("2026-08") — the spending block's month. */
  currentPeriod: string;
  currentPeriodLabel: string; // "August 2026"
  accounts: AccountRow[];
  /** Donut for the lived-in month; null when it has no spending row or nothing drawable. */
  donut: { slices: DonutSliceData[]; total: number } | null;
  /**
   * Net totalSpending for the lived-in month (single source:
   * spendingBreakdown). Null means NO row yet — "nothing recorded", which is
   * a different claim from a $0.00 month.
   */
  spendingTotal: number | null;
  /** The latest complete month with a spending row — the quiet link out of an empty month. */
  priorSpending: { period: string; monthName: string; total: number } | null;
  /** Held, invested and owed, so the balance table does not have to be added up by eye. */
  balances: BalanceSummary;
  /** Months of cash at recent spending; null when the evidence refuses. */
  runway: Runway | null;
  health: ProviderHealth[];
  lastSyncAt: Date | null;
  /**
   * Non-transfer transactions with no category and no reimbursement link.
   * The single loudest signal on launch: spending analytics are incomplete
   * until this is zero.
   */
  uncategorizedCount: number;
  /**
   * Pack rules the shipped code defines that this database does not have. A
   * pack change arrives with `git pull` and reaches the data through nothing,
   * so without surfacing this an instance runs old categorization rules and
   * nothing anywhere says so.
   */
  pendingPackRules: number;
}

const TYPE_ORDER: Record<string, number> = { DEPOSITORY: 0, INVESTMENT: 1, CREDIT: 2, LOAN: 3 };

export async function getOverviewData(): Promise<OverviewData> {
  // Everything this page needs, read once and in parallel. It used to issue
  // its queries one after another — four of them full scans of the Insight
  // table, with RECURRING_CHARGE fetched twice over.
  const [
    insightRows,
    accountRows,
    snapshots,
    uncategorizedCount,
    lastOk,
    health,
    cashAccountIds,
    packDrift,
  ] = await Promise.all([
      prisma.insight.findMany(),
      prisma.account.findMany(),
      prisma.balanceSnapshot.groupBy({ by: ["accountId"], _max: { date: true } }),
      prisma.transaction.count({
        where: { categoryId: null, flow: { not: "TRANSFER" }, reimbursesId: null },
      }),
      prisma.syncLog.findFirst({ where: { ok: true }, orderBy: { finishedAt: "desc" } }),
      // Overview reads only per-account staleness from this — 'accounts'
      // skips the FRED card's Setting read, a round trip it never renders.
      getProviderHealth(prisma, { ...DEFAULT_HEALTH_OPTIONS, scope: "accounts" }),
      readCashAccountIds(prisma),
      pendingPackRules(prisma),
    ]);

  const monthly = monthlyRows(insightRows);
  // ONE `now` for the whole page: the spending block's month, the runway's
  // complete-month cut and the context's "complete" boundary must agree on
  // which month is being lived in, or a render straddling UTC midnight puts
  // different months on one screen. UTC via periodKey, like every period
  // bound in the app.
  const now = new Date();
  const currentPeriod = periodKey(now, "MONTH");
  // ofType is oldest-first, the order charts plot in. This page reads the
  // latest COMPLETE month for context, so it takes from the end rather than
  // flipping the shared default out from under Trends. Strictly before the
  // lived-in month: a partial month's growth figure drifts all month, and the
  // context's job is to be a settled fact under a live headline.
  const netWorthAll = ofType<NetWorthGrowthPayload>(monthly, "NET_WORTH_GROWTH").filter(
    (r) => r.period < currentPeriod,
  );
  const latestComplete = netWorthAll[netWorthAll.length - 1] ?? null;
  const snapshotByAccount = new Map(snapshots.map((s) => [s.accountId, s._max.date]));
  // Health already decided which balances are stale, on its own tuned bar.
  // Re-deriving it here would be a second threshold to keep in step.
  const staleIds = new Set(health.flatMap((h) => h.staleAccounts.map((s) => s.accountId)));
  const syncedAt = lastOk?.finishedAt?.getTime() ?? null;
  const accounts: AccountRow[] = accountRows
    .map((a) => {
      const snapDate = snapshotByAccount.get(a.id) ?? null;
      const balance = Number(a.balance);
      return {
        id: a.id,
        name: a.name,
        institution: a.institution,
        type: a.type,
        balance,
        snapshotBacked: snapDate !== null,
        snapshotDate: snapDate === null ? null : shortDate(snapDate),
        balanceLagDays:
          syncedAt === null ? 0 : Math.max(0, Math.floor((syncedAt - a.balanceDate.getTime()) / 86_400_000)),
        stale: staleIds.has(a.id),
        isCash: countsAsCash({ id: a.id, type: a.type, balance }, cashAccountIds),
      };
    })
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || b.balance - a.balance);

  const balances = summariseBalances(accounts, cashAccountIds);
  // The headline: the plain sum of the signed balances the table below prints.
  // Live by definition — no insight row stands between the accounts and their
  // own total, so the figure cannot lag a sync the way the old (latest
  // NET_WORTH_GROWTH row) headline did.
  const liveNetWorth = accounts.reduce((sum, a) => sum + a.balance, 0);
  // Complete months only, and the app's OWN spending figure — the same
  // totalSpending /trends and /insights print, so no third definition appears.
  const spendingSeries = ofType<SpendingByCategoryPayload>(monthly, "SPENDING_BY_CATEGORY");
  const runway = computeRunway(
    balances.cash,
    spendingSeries.filter((s) => s.period < currentPeriod).map((s) => s.payload.totalSpending),
  );

  // The spending block shows the month being LIVED IN — never a past month
  // under a "this month" caption. Both figures go through spendingBreakdown,
  // the single source of every printed total, so no second summation appears.
  const currentSpending = spendingSeries.find((s) => s.period === currentPeriod) ?? null;
  const breakdown = currentSpending === null ? null : spendingBreakdown(currentSpending.payload);
  const priorRows = spendingSeries.filter((s) => s.period < currentPeriod);
  const priorRow = priorRows[priorRows.length - 1] ?? null;
  const currentYear = currentPeriod.slice(0, 4);

  const contextLabel = latestComplete === null ? null : monthLabel(latestComplete.period);

  return {
    liveNetWorth,
    monthContext:
      latestComplete === null || contextLabel === null
        ? null
        : {
            period: latestComplete.period,
            label: contextLabel,
            monthName: contextLabel.split(" ")[0],
            growthRate: latestComplete.payload.growthRate,
            marketGains: latestComplete.payload.marketGains,
            estimatedCount: latestComplete.payload.estimatedAccountIds.length,
          },
    currentPeriod,
    currentPeriodLabel: monthLabel(currentPeriod),
    accounts,
    donut: breakdown?.donut ?? null,
    spendingTotal: breakdown === null ? null : breakdown.total,
    priorSpending:
      priorRow === null
        ? null
        : {
            period: priorRow.period,
            // Name alone within the lived-in year; a link into another year
            // carries it, or "December" under an August header would read as
            // four months ago.
            monthName:
              priorRow.period.slice(0, 4) === currentYear
                ? monthLabel(priorRow.period).split(" ")[0]
                : monthLabel(priorRow.period),
            total: spendingBreakdown(priorRow.payload).total,
          },
    balances,
    runway,
    health,
    lastSyncAt: lastOk?.finishedAt ?? null,
    uncategorizedCount,
    pendingPackRules: packDrift,
  };
}
