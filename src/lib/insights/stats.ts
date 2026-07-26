export function median(values: number[]): number {
  if (values.length === 0) throw new Error('median of empty array');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Median absolute deviation. */
export function mad(values: number[]): number {
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

export const ROBUST_Z_CAP = 99;

/**
 * Robust z-score: (x - median) / (1.4826 * MAD), capped at ROBUST_Z_CAP.
 * When MAD is 0 (constant history), returns 0 if x matches the median,
 * otherwise the cap — any deviation from a perfectly constant history is
 * infinitely surprising, so the caller's threshold decides via magnitude.
 */
export function robustZ(x: number, history: number[]): number {
  return robustZFrom(x, median(history), mad(history));
}

/**
 * robustZ against an already-computed centre and spread. Both median and MAD
 * sort the history, so a caller comparing many values against the SAME
 * history (every transaction in a period against its category's past) can
 * compute them once instead of four sorts per transaction.
 */
export function robustZFrom(x: number, m: number, d: number): number {
  if (d === 0) return x === m ? 0 : ROBUST_Z_CAP;
  return Math.min(Math.abs(x - m) / (1.4826 * d), ROBUST_Z_CAP);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Relative change; null when there is no meaningful base to compare against.
 * A NON-POSITIVE base is one of those: a sign flip is not a percentage
 * increase. June's rent was −$409.73 (a refund month), so dividing July's
 * $4,655.60 by |−409.73| rendered "×13.4" in the page's heaviest style — the
 * most confident number on the screen, and it measured nothing.
 */
export function pctDelta(current: number, previous: number | null): number | null {
  if (previous === null || previous <= 0) return null;
  return round4((current - previous) / previous);
}
