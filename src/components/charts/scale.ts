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
