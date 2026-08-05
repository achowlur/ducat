import { prisma } from "../prisma";
import {
  BACKUP_SETTING_KEY,
  deriveBackupStatus,
  parseBackupRun,
  type BackupSignal,
} from "../health/backup";
import { getProviderHealth } from "../health/health";
import { PROVIDER_TRUST_CARDS } from "../health/providers";
import type { ProviderHealth, ProviderId } from "../health/types";
import { FRED_API_KEY_ENV, FRED_SERIES_ID } from "../rates/mortgageRate";

/**
 * ONE status→colour mapping for every surface that paints a provider status.
 *
 * Overview carried its own three-way expression whose fallback painted
 * UNKNOWN amber, while this module's table painted it grey — so one status
 * wore two colours on two pages. The three levels of specificity (provider
 * strip, account row, review panel) are escalation, and escalation only reads
 * as escalation when the levels agree about severity.
 */
export const STATUS_DOT: Record<string, string> = {
  OK: 'bg-pos',
  WARN: 'bg-chart2',
  ERROR: 'bg-neg',
  UNKNOWN: 'bg-faint',
};

/**
 * WARN and UNKNOWN fell into the same `else` and wore an identical chip, so a
 * provider with a live problem looked exactly like one that was never set up.
 * WARN takes the amber it already had on its DOT; UNKNOWN keeps the neutral
 * chip, which is what "nothing to report yet" should look like.
 */
export const STATUS_CHIP: Record<string, string> = {
  OK: 'bg-pos text-paper',
  WARN: 'bg-chart2 text-paper',
  ERROR: 'bg-neg text-paper',
  UNKNOWN: 'bg-chip text-acc',
};

/**
 * The sync schedule, in words, read from `vercel.json` rather than retyped.
 *
 * /providers could not answer "how often" at all: `schedule`, `cron`,
 * `nightly` and `23:00` appeared zero times on the page, while the FRED trust
 * card's residual-risk line said FRED can see the key ask for the series "at
 * your sync times" — naming a fact the page never stated. The disclosure rule
 * for a read-only external fetch owes the reader the IP, the key, the series
 * AND, riding the sync, the instance's schedule; three of the four were there.
 *
 * Derived from the config so the sentence cannot drift from the cron that
 * actually fires. Only the shipped `0 H * * *` shape is put into words; any
 * other expression is printed verbatim rather than mistranslated.
 */
export function cronSummary(schedule: string): string {
  const daily = /^0 (\d{1,2}) \* \* \*$/.exec(schedule);
  if (daily === null) return `on the schedule \`${schedule}\` (UTC)`;
  return `once a day at ${daily[1].padStart(2, '0')}:00 UTC`;
}

/**
 * The last verified local backup, as THIS database's Setting records it —
 * which is the point of the Setting's cloud placement: the phone reads the
 * cloud instance, whose filesystem could never see data/backups/. Null when
 * never recorded (fresh instance, or a local-only user with no cloud
 * database to back up), and then /providers renders no backup line at all —
 * the FRED precedent for a feature never opted into.
 */
export async function getBackupSignal(now: Date = new Date()): Promise<BackupSignal | null> {
  const row = await prisma.setting.findUnique({ where: { key: BACKUP_SETTING_KEY } });
  return deriveBackupStatus(parseBackupRun(row?.value ?? null), now);
}

export interface SyncLogRow {
  id: string;
  finishedAt: Date;
  durationMs: number;
  ok: boolean;
  errorText: string | null;
  feedErrors: string[];
  accountsSeen: number;
  transactionsImported: number;
  transactionsSkipped: number;
  rulesApplied: number;
  transfersLinked: number;
}

export interface ProviderView {
  health: ProviderHealth;
  /** SIMPLEFIN: access URL present in env. FRED: API key present in env.
   * CSV: always true (no standing credential). */
  configured: boolean;
  /** Shown when the provider isn't set up yet — the exact command to run. */
  setupHint: string | null;
  syncLogs: SyncLogRow[];
  /** Every log row this connector has, not just the page shown. */
  logsTotal: number;
  /** 1-based page the syncLogs slice is. */
  logsPage: number;
}

/**
 * Sync-history page size. Five rows answer "is it running and did last night
 * work"; everything older is a record you consult, one page at a time. The
 * old shape — `take: 20` with no way past 20 — was the capping-without-paging
 * bug /transactions shipped twice, latent here because SyncLog outgrows 20
 * within a month of nightly syncs.
 */
export const LOGS_PAGE_SIZE = 5;

const SETUP_HINTS: Record<ProviderId, string> = {
  // Deliberately says "this instance's environment" rather than ".env": the
  // claim script runs on your machine either way, but a cloud deployment reads
  // the access URL from the platform's variable store (see DEPLOY.md).
  SIMPLEFIN:
    "npm run simplefin:claim -- <setup-token>  →  set the printed SIMPLEFIN_ACCESS_URL in this instance's environment  →  npm run sync:simplefin",
  CSV: "npm run import:csv -- <file.csv> --mapping=<chase-checking|chase-credit|wells-fargo|fidelity> --name=<account> --type=<DEPOSITORY|CREDIT|INVESTMENT|LOAN> --institution=<bank>",
  FRED:
    `get a free API key at fredaccount.stlouisfed.org/apikeys  →  set ${FRED_API_KEY_ENV} in this instance's environment  →  the next sync stores the day's ${FRED_SERIES_ID} observation. ` +
    "Used by the /insights readiness panel only when its config declares no typed rate (npm run readiness -- --fetched-rate).",
};

/**
 * Every known provider renders — including ones not set up yet, so the
 * trust card (data path, residual risks, revocation) is readable BEFORE
 * connecting, which is when it matters most. The access URL itself is a
 * credential and is never read into page data — only its presence.
 *
 * `paging` selects which connector's history is being paged (from
 * `?logs=&logsPage=`); every other connector shows page 1. The page is
 * clamped into range, so a hand-typed `?logsPage=99` lands on the last
 * page rather than an empty table.
 */
export async function getProvidersData(
  paging: { connector?: string; page?: number } = {},
): Promise<ProviderView[]> {
  const health = await getProviderHealth(prisma);
  const byType = new Map(health.map((h) => [h.connectorType, h]));

  // ONE groupBy carries every connector's total: a count() inside the loop
  // would be three sequential round trips (one of them FRED's, which writes
  // no SyncLog and counts zero forever), and on Turso the COUNT of round
  // trips is the cost (performance.md). A zero total also skips that
  // connector's page query, so the whole pager costs the page nothing over
  // the pre-pagination shape.
  const totals = await prisma.syncLog.groupBy({ by: ["connectorType"], _count: true });
  const totalFor = new Map(totals.map((t) => [t.connectorType, t._count]));

  const views: ProviderView[] = [];
  for (const card of Object.values(PROVIDER_TRUST_CARDS)) {
    const existing = byType.get(card.connectorType) ?? null;
    const h: ProviderHealth =
      existing ?? {
        connectorType: card.connectorType,
        trustCard: card,
        status: "UNKNOWN",
        reasons: ["Not set up yet"],
        lastSync: null,
        lastSuccessfulSyncAt: null,
        syncOverdue: false,
        accountCount: 0,
        staleAccounts: [],
        gappedAccounts: [],
      };

    const logsTotal = totalFor.get(card.connectorType) ?? 0;
    const lastPage = Math.max(1, Math.ceil(logsTotal / LOGS_PAGE_SIZE));
    const requested =
      paging.connector === card.connectorType && Number.isInteger(paging.page) ? paging.page! : 1;
    const logsPage = Math.min(Math.max(1, requested), lastPage);
    const logs =
      logsTotal === 0
        ? []
        : await prisma.syncLog.findMany({
            where: { connectorType: card.connectorType },
            orderBy: { finishedAt: "desc" },
            take: LOGS_PAGE_SIZE,
            skip: (logsPage - 1) * LOGS_PAGE_SIZE,
          });

    const configured =
      card.connectorType === "SIMPLEFIN"
        ? (process.env.SIMPLEFIN_ACCESS_URL ?? "") !== ""
        : card.connectorType === "FRED"
          ? (process.env[FRED_API_KEY_ENV] ?? "") !== ""
          : true;

    views.push({
      health: h,
      configured,
      logsTotal,
      logsPage,
      setupHint:
        ((card.connectorType === "SIMPLEFIN" || card.connectorType === "FRED") && !configured) ||
        (existing === null && card.connectorType === "CSV")
          ? SETUP_HINTS[card.connectorType]
          : null,
      syncLogs: logs.map((l) => ({
        id: l.id,
        finishedAt: l.finishedAt,
        durationMs: l.finishedAt.getTime() - l.startedAt.getTime(),
        ok: l.ok,
        errorText: l.errorText,
        feedErrors: Array.isArray(l.feedErrors) ? l.feedErrors.map(String) : [],
        accountsSeen: l.accountsSeen,
        transactionsImported: l.transactionsImported,
        transactionsSkipped: l.transactionsSkipped,
        rulesApplied: l.rulesApplied,
        transfersLinked: l.transfersLinked,
      })),
    });
  }
  return views;
}
