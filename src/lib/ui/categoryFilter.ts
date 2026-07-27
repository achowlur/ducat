/**
 * The `?category=` wire format for `/transactions`, encoded and decoded in ONE
 * place so a link and the page that receives it cannot disagree.
 *
 * A single category id, or the literal `uncategorized` for rows with no
 * category, or a comma-separated list of either. The list exists because the
 * donut's "Other" slice is a SET of categories — everything ranked 4th and
 * below — and which categories those are CHANGES BY PERIOD. So a link has to
 * enumerate the ids for the month on screen; a static `other` token would mean
 * something different in every month, and an exclusion list would silently
 * swallow any category added later.
 *
 * `null` is a real bucket here (Uncategorized), not an absence, which is the
 * distinction the donut used to lose: "Other" and "Uncategorized" both carried
 * `categoryId: null`, so clicking either dropped the filter and showed the
 * whole ledger.
 */

export const UNCATEGORIZED = "uncategorized";

export interface CategorySelection {
  /** Real category ids. */
  ids: string[];
  /** Whether rows with no category are included. */
  uncategorized: boolean;
}

/** Build the param value from category ids, where `null` means uncategorized. */
export function encodeCategoryParam(categoryIds: (string | null)[]): string {
  const seen = new Set<string>();
  for (const id of categoryIds) {
    const token = id ?? UNCATEGORIZED;
    if (token !== "") seen.add(token);
  }
  return [...seen].join(",");
}

/** Parse it back. Returns null when there is no category filter at all. */
export function parseCategoryParam(value: string | undefined): CategorySelection | null {
  if (value === undefined || value.trim() === "") return null;
  const ids: string[] = [];
  let uncategorized = false;
  for (const raw of value.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    if (token === UNCATEGORIZED) uncategorized = true;
    else if (!ids.includes(token)) ids.push(token);
  }
  if (ids.length === 0 && !uncategorized) return null;
  return { ids, uncategorized };
}

/** `/transactions` link for a set of categories in a period. */
export function transactionsHref(categoryIds: (string | null)[], period?: string): string {
  const params = new URLSearchParams();
  if (period !== undefined && period !== "") params.set("period", period);
  const category = encodeCategoryParam(categoryIds);
  if (category !== "") params.set("category", category);
  const qs = params.toString();
  return qs === "" ? "/transactions" : `/transactions?${qs}`;
}
