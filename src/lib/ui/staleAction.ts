import { pollsForBalances } from "../health/health";

/** SimpleFIN's hosted flow, where a frozen connection is reconnected. Credentials never touch this app. */
export const SIMPLEFIN_RECONNECT_URL = "https://bridge.simplefin.org";

export interface StaleCandidate {
  name: string;
  connectorType: string;
  /** Days behind the LAST SYNC, the number the "Nd behind" chip prints. */
  balanceLagDays: number;
  /** The page's own verdict that this row wears the chip (each page keeps its threshold). */
  behind: boolean;
}

export interface StaleAction {
  /** The alert's sentence. */
  sentence: string;
  /** Where the Reconnect control points. */
  href: string;
  /** The accounts it names, in the order given. */
  names: string[];
}

function list(names: string[]): string {
  return names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Which accounts the stale alert names, the sentence, and the link. Only
 * accounts a feed polls can be reconnected, so a statement-only (CSV/PDF)
 * account is never named, whatever its age. Null when nothing is behind.
 */
export function staleAction(accounts: StaleCandidate[]): StaleAction | null {
  const stale = accounts.filter((a) => a.behind && pollsForBalances(a.connectorType));
  if (stale.length === 0) return null;
  const names = stale.map((a) => a.name);
  if (stale.length === 1) {
    const days = stale[0].balanceLagDays;
    return {
      sentence: `${names[0]} is ${days > 0 ? `${days} ${days === 1 ? "day" : "days"} behind` : "behind the last sync"}`,
      href: SIMPLEFIN_RECONNECT_URL,
      names,
    };
  }
  return {
    sentence: `${stale.length} accounts are behind: ${list(names)}`,
    href: SIMPLEFIN_RECONNECT_URL,
    names,
  };
}
