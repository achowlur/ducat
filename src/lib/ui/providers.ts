import type { ConnectorType } from "../../types/contracts";
import { prisma } from "../prisma";
import { getProviderHealth } from "../health/health";
import { PROVIDER_TRUST_CARDS } from "../health/providers";
import type { ProviderHealth } from "../health/types";

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
  /** SIMPLEFIN: access URL present in env. CSV: always true (no standing credential). */
  configured: boolean;
  /** Shown when the provider isn't set up yet — the exact command to run. */
  setupHint: string | null;
  syncLogs: SyncLogRow[];
}

const SETUP_HINTS: Record<ConnectorType, string> = {
  SIMPLEFIN:
    "npm run simplefin:claim -- <setup-token>  →  paste the printed SIMPLEFIN_ACCESS_URL into .env  →  npm run sync:simplefin",
  CSV: "npm run import:csv -- <file.csv> --mapping=<chase-checking|chase-credit|wells-fargo|fidelity> --name=<account> --type=<DEPOSITORY|CREDIT|INVESTMENT|LOAN> --institution=<bank>",
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
        : true;

    views.push({
      health: h,
      configured,
      setupHint:
        (card.connectorType === "SIMPLEFIN" && !configured) || (existing === null && card.connectorType === "CSV")
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
