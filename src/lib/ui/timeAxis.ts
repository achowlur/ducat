/**
 * Labels for a month axis that zooms. Months are labelled on CALENDAR steps
 * (every month, every other, quarters, halves), so moving along the line never
 * makes a label hop to a different month; when even halves would crowd, the
 * axis names years alone. A label too close to an edge to print whole is left
 * out rather than clipped.
 */

const STEPS = [1, 2, 3, 6] as const;

/** The calendar step months are labelled at, or null when only years fit. */
export function monthStep(unitsPerMonth: number, minLabelUnits: number): number | null {
  return STEPS.find((step) => unitsPerMonth * step >= minLabelUnits) ?? null;
}

const monthOf = (period: string) => Number(period.slice(5, 7)) - 1;

/** Indices in [first, last] whose month falls on the step: Jan, Apr, Jul, Oct for quarters. */
export function monthTicks(periods: string[], first: number, last: number, step: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, first); i <= Math.min(periods.length - 1, last); i++) {
    if (monthOf(periods[i]) % step === 0) out.push(i);
  }
  return out;
}

export interface YearSpan {
  year: string;
  /** Index of the year's first and last month in the series. */
  start: number;
  end: number;
}

export function yearSpans(periods: string[]): YearSpan[] {
  const spans: YearSpan[] = [];
  periods.forEach((p, i) => {
    const year = p.slice(0, 4);
    const lastSpan = spans.at(-1);
    if (lastSpan !== undefined && lastSpan.year === year) lastSpan.end = i;
    else spans.push({ year, start: i, end: i });
  });
  return spans;
}

/**
 * Where each year's label sits: the middle of the part of the year on show,
 * in index units. A year with too little on show to hold its label is left
 * out, and when years themselves crowd only every other one is named. The
 * NEWEST year on show is always named, the label before it giving way if the
 * two would touch: a phone's whole history named every year but the one the
 * line ends in, because the few months of it on record were too narrow.
 */
export function yearLabels(
  spans: YearSpan[],
  window: { start: number; end: number },
  unitsPerMonth: number,
  minLabelUnits: number,
): { year: string; at: number }[] {
  const every = unitsPerMonth * 12 >= minLabelUnits ? 1 : 2;
  // A year owns the half-month either side of its first and last points.
  const onShow = (s: YearSpan) => ({ from: Math.max(s.start - 0.5, window.start), to: Math.min(s.end + 0.5, window.end) });
  const newest = spans.filter((s) => onShow(s).to > onShow(s).from).at(-1);
  const labels = spans.flatMap((s) => {
    const { from, to } = onShow(s);
    // Centred on its part of the year, but never so near the end that the
    // label would run past it.
    if (s === newest) return [{ year: s.year, at: Math.min((from + to) / 2, to - minLabelUnits / 2 / unitsPerMonth) }];
    if ((to - from) * unitsPerMonth < minLabelUnits) return [];
    if (every === 2 && Number(s.year) % 2 !== 0) return [];
    return [{ year: s.year, at: (from + to) / 2 }];
  });
  const room = minLabelUnits / unitsPerMonth;
  return labels.filter((l, i) => i !== labels.length - 2 || labels[i + 1].at - l.at >= room);
}
