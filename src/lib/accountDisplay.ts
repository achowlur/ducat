/**
 * How an account is SHOWN, kept apart from what the feed calls it.
 *
 * The feed's name is the account's identity: the reconnect matcher reads its
 * trailing number (sync/relink.ts) and ACCOUNT rules match it (sync/rules.ts),
 * and every sync rewrites it. A bank nickname never reaches the feed, so a
 * name a person can read ("Brokerage" rather than "Individual - TOD") lives
 * here, in a Setting, and every page prints it in place of the feed's. The
 * account number stays beside it, so which feed account it is never gets lost.
 *
 * Settings rather than columns: per-instance choices, and a column would be a
 * schema change pushed by hand to every cloud database.
 */

/** Setting: { [accountId]: name } typed on /accounts. */
export const ACCOUNT_NAMES_KEY = "accounts.displayNames";
/** Setting: ids of accounts left out of Overview's account table (never out of any total). */
export const HIDDEN_ON_OVERVIEW_KEY = "accounts.hiddenOnOverview";

/** A typed name at most this long; the number is added after it. */
export const MAX_ACCOUNT_NAME = 40;

export function parseAccountNames(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === "string" && name.trim() !== "") out[id] = name;
    }
    return out;
  } catch {
    return {}; // a corrupted setting shows the feed's names; it never takes a page down
  }
}

export function parseHiddenOnOverview(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/** The trailing account number of a feed name ("Individual - TOD (0003)" → "0003"), if it has one. */
export function accountNumber(feedName: string): string | null {
  return /(\d{3,})\D*$/.exec(feedName)?.[1] ?? null;
}

/** Whitespace collapsed and trimmed; null when nothing is left (which clears a name). */
export function normalizeAccountName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  return name === "" ? null : name;
}

/** The name to print: the typed one with the feed's account number beside it, else the feed's own. */
export function accountLabel(account: { id: string; name: string }, names: Readonly<Record<string, string>>): string {
  const typed = names[account.id];
  if (typed === undefined) return account.name;
  const number = accountNumber(account.name);
  return number === null || typed.includes(number) ? typed : `${typed} (${number})`;
}

/** The same rows with their names replaced by the printed ones; what every page loader hands on. */
export function withAccountLabels<T extends { id: string; name: string }>(
  accounts: readonly T[],
  names: Readonly<Record<string, string>>,
): T[] {
  return accounts.map((a) => (names[a.id] === undefined ? a : { ...a, name: accountLabel(a, names) }));
}
