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

import { isUnreviewedP2P, P2P_UNREVIEWED_ID } from "../p2p";

export const UNCATEGORIZED = "uncategorized";

/*
 * The other bucket of rows with no category is `p2p-unreviewed`
 * (P2P_UNREVIEWED_ID): P2P payments awaiting confirmation, see ../p2p.ts.
 * Uncategorized and P2P — Unreviewed are DISJOINT — each drills into exactly
 * the rows its own slice counts — so a row with no category belongs to one or
 * the other, never both.
 */

export interface CategorySelection {
  /** Real category ids. */
  ids: string[];
  /** Rows with no category that are NOT a P2P payment awaiting confirmation. */
  uncategorized: boolean;
  /** P2P payments awaiting confirmation. */
  p2p: boolean;
}

/**
 * Whether a row with NO category belongs to the selection. SQL can only ask
 * "category is null", and the P2P test is a regex over two columns, so the
 * split between the two null buckets is finished in memory. Null when no split
 * is needed — both buckets or neither — so callers can keep paging in SQL.
 */
export function nullBucketFilter(
  selection: CategorySelection | null,
): ((t: Parameters<typeof isUnreviewedP2P>[0]) => boolean) | null {
  if (selection === null || selection.uncategorized === selection.p2p) return null;
  return (t) => t.categoryId !== null || (isUnreviewedP2P(t) ? selection.p2p : selection.uncategorized);
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
  let p2p = false;
  for (const raw of value.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    if (token === UNCATEGORIZED) uncategorized = true;
    else if (token === P2P_UNREVIEWED_ID) p2p = true;
    else if (!ids.includes(token)) ids.push(token);
  }
  if (ids.length === 0 && !uncategorized && !p2p) return null;
  return { ids, uncategorized, p2p };
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
