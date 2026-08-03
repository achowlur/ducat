/** Round a raw step up to 1/2/2.5/5 × 10^n. */
function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

/**
 * Gridline values on rounded boundaries. The first tick is ≤ min and the
 * last tick is ≥ max — data must never overflow the scale.
 */
export function niceTicks(min: number, max: number, targetCount = 4): number[] {
  if (min === max) {
    max = min + 1;
  }
  const step = niceStep((max - min) / targetCount);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 0.001; v += step) {
    ticks.push(Math.round(v * 100) / 100);
  }
  return ticks;
}

/** Compact axis money label: 39264.69 → "$39.3k", 500 → "$500". */
export function axisMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * A month label carrying its year: "Oct 2025".
 *
 * The axis thins its labels and sits above a year band precisely because
 * "Jun" appears three times across 26 months — but the TOOLTIP, which is the
 * only place exact figures live, reintroduced that ambiguity by printing the
 * bare month. Two Octobers and three Junes produced identical headings.
 */
export function monthWithYear(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Which indices of an axis get a label, thinned to what fits and stepped from
 * the END so the newest is always one of them.
 *
 * Extracted from CashFlowChart because NetWorthChart needed the same rule and
 * had none: it labelled every month unconditionally. That was comfortable at
 * seven points and arithmetic says it stops being so at thirteen — mobile
 * gives 246px of plot, so spacing is 246/(n−1) against labels 17-18px wide,
 * which touches at n=13 and overlaps at n=15. The series began 2026-01 and
 * grows one point per month, so n=13 arrives in January 2027.
 *
 * Takes the SPACING, not the count: bars occupy n slots and line points sit at
 * n−1 intervals, so each caller owns the geometry it actually has.
 */
export function labelStepFor(perItemPx: number, minLabelPx: number): number {
  if (!(perItemPx > 0)) return 1;
  return Math.max(1, Math.ceil(minLabelPx / perItemPx));
}
