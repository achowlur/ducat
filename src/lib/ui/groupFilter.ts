/**
 * The `?group=` wire format for `/transactions` — the trip/project filter —
 * written and read in ONE place so a link and the page that receives it cannot
 * disagree (the `?category=` discipline, applied to the second filter that
 * earned it).
 *
 * The param value IS the label. Labels are human-typed ("Tess's March trip"),
 * so spaces and apostrophes must survive the whole trip: assignment → URL →
 * filter → totals band → the /insights link back. URLSearchParams does the
 * percent-encoding on the way out and Next decodes on the way in; the
 * round-trip is pinned by groupFilter.test.ts.
 *
 * A group is a cross-period VIEW over real rows, never a re-bucketing: nothing
 * in the insights engine reads `groupLabel`, and no analyzer may start to.
 */

/** Longest label the assignment action accepts. */
export const MAX_GROUP_LABEL = 80;

/**
 * Canonical label form: trimmed, runs of whitespace collapsed — the same
 * collapse discipline rule matching uses, so two labels can never differ by an
 * invisible double space. Returns null for an empty (or whitespace-only) input.
 */
export function normalizeGroupLabel(raw: string): string | null {
  const label = raw.replace(/\s+/g, " ").trim();
  return label === "" ? null : label;
}

/**
 * Parse the `?group=` value. Null means no group filter at all — there is no
 * synthetic bucket here (an untagged row is an absence, not a group), which is
 * where this deliberately differs from `?category=`'s `uncategorized` token.
 */
export function parseGroupParam(value: string | undefined): string | null {
  if (value === undefined) return null;
  return normalizeGroupLabel(value);
}

/** `/transactions` link filtered to one group's rows. */
export function groupHref(label: string): string {
  const params = new URLSearchParams();
  params.set("group", label);
  return `/transactions?${params.toString()}`;
}
