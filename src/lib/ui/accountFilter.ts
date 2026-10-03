/**
 * The `?account=` wire format for `/transactions`, written and read in ONE
 * place so a link and the page that receives it cannot disagree (the
 * `?category=` discipline, applied to the third filter to earn it).
 *
 * One account id, or a comma-separated list of them. An INCLUSION list, as
 * `?category=` is and for its reason: a link naming three accounts goes on
 * meaning those three when a fourth is connected, where an exclusion list
 * would quietly start showing it.
 *
 * A single id is a list of one, so every link written before the list existed
 * (`/accounts`' "transactions →") reads exactly as it did.
 *
 * There is no synthetic bucket here. Every transaction has an account, so
 * there is nothing for an `uncategorized`-style token to mean.
 */

/** Build the param value. Empty when there is no filter. */
export function encodeAccountParam(accountIds: readonly string[]): string {
  const seen = new Set<string>();
  for (const id of accountIds) {
    const token = id.trim();
    if (token !== "") seen.add(token);
  }
  return [...seen].join(",");
}

/**
 * Parse it back. Null means no account filter at all.
 *
 * Takes an array too: a repeated key (`?account=a&account=b`, which is what a
 * plain form of checkboxes would send) reaches the page as one, and reading
 * only the first would apply half a filter without saying so.
 */
export function parseAccountParam(value: string | string[] | undefined): string[] | null {
  if (value === undefined) return null;
  const ids: string[] = [];
  for (const part of Array.isArray(value) ? value : [value]) {
    for (const raw of part.split(",")) {
      const token = raw.trim();
      if (token !== "" && !ids.includes(token)) ids.push(token);
    }
  }
  return ids.length === 0 ? null : ids;
}

/** `/transactions` link filtered to a set of accounts. */
export function accountsHref(accountIds: readonly string[]): string {
  const account = encodeAccountParam(accountIds);
  if (account === "") return "/transactions";
  const params = new URLSearchParams();
  params.set("account", account);
  return `/transactions?${params.toString()}`;
}

/**
 * What the collapsed control says. `names` are the selected accounts that
 * exist; `selectedCount` is how many ids the filter carries. They differ when
 * a link names an account that has since gone, and the control must not read
 * "All" over a filter that is matching nothing.
 */
export function accountFilterSummary(names: readonly string[], selectedCount: number): string {
  if (selectedCount === 0) return "All";
  if (names.length === 0) return "Unknown account";
  return names.length === 1 ? names[0] : `${names.length} accounts`;
}
