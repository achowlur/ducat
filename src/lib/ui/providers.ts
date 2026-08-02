import { prisma } from "../prisma";
import { getProviderHealth } from "../health/health";
import { PROVIDER_TRUST_CARDS } from "../health/providers";
import type { ProviderHealth, ProviderId } from "../health/types";
import { FRED_API_KEY_ENV, FRED_SERIES_ID } from "../rates/mortgageRate";

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
}

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
 */
export async function getProvidersData(): Promise<ProviderView[]> {
  const health = await getProviderHealth(prisma);
  const byType = new Map(health.map((h) => [h.connectorType, h]));

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

    const logs = await prisma.syncLog.findMany({
      where: { connectorType: card.connectorType },
      orderBy: { finishedAt: "desc" },
      take: 20,
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
