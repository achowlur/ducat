/**
 * The stretch of a month series a chart shows, in index units: `start` and
 * `end` are positions along the series (0 is its first month), fractional
 * while a gesture is between months. Pure, so the gestures' arithmetic is
 * tested without a browser.
 */
export interface ChartWindow {
  start: number;
  end: number;
}

/** The fewest months between a window's edges: four points, enough to read a slope. */
export const MIN_SPAN = 3;

export function fullWindow(count: number): ChartWindow {
  return { start: 0, end: Math.max(0, count - 1) };
}

/** The narrowest window a series allows: MIN_SPAN, or all of a shorter series. */
function minSpan(count: number): number {
  return Math.min(MIN_SPAN, Math.max(0, count - 1));
}

/** A window held inside the series and between the narrowest and the whole. */
export function clampWindow(w: ChartWindow, count: number): ChartWindow {
  const full = Math.max(0, count - 1);
  const span = Math.min(full, Math.max(minSpan(count), w.end - w.start));
  const start = Math.min(full - span, Math.max(0, w.start));
  return { start, end: start + span };
}

export function isFull(w: ChartWindow, count: number): boolean {
  return w.start <= 1e-6 && w.end >= count - 1 - 1e-6;
}

/**
 * Scales the window by `factor` (below 1 zooms in) about `anchor`, the
 * pointer's place across the plot from 0 (left edge) to 1 (right edge), so
 * the month under the pointer stays under it.
 */
export function zoomAround(w: ChartWindow, factor: number, anchor: number, count: number): ChartWindow {
  const span = w.end - w.start;
  const at = w.start + anchor * span;
  const next = span * factor;
  return clampWindow({ start: at - anchor * next, end: at - anchor * next + next }, count);
}

/** Moves the window `delta` months along the series, its width kept. */
export function panBy(w: ChartWindow, delta: number, count: number): ChartWindow {
  return clampWindow({ start: w.start + delta, end: w.end + delta }, count);
}

/**
 * A two-finger gesture, measured from where it began: the fingers' spread
 * sets the width (twice as far apart shows half as many months), and the
 * month that was under their midpoint follows the midpoint, so spreading
 * zooms and sliding both fingers moves along the line in one motion.
 */
export function pinchWindow(
  from: ChartWindow,
  fromSpread: number,
  spread: number,
  fromAnchor: number,
  anchor: number,
  count: number,
): ChartWindow {
  const span = (from.end - from.start) * (fromSpread / Math.max(spread, 1));
  const clamped = Math.min(Math.max(0, count - 1), Math.max(minSpan(count), span));
  const at = from.start + fromAnchor * (from.end - from.start);
  return clampWindow({ start: at - anchor * clamped, end: at - anchor * clamped + clamped }, count);
}

/** The whole months a window shows: the first and last index inside it. */
export function shownMonths(w: ChartWindow): { first: number; last: number } {
  return { first: Math.ceil(w.start - 1e-6), last: Math.floor(w.end + 1e-6) };
}
