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

/**
 * The same for a DAY axis: days of the month labelled on calendar steps
 * (every day, every other, the 1st, 8th, 15th, 22nd and 29th, the 1st, 15th
 * and 29th, the 1st), so panning never moves a label to another day.
 */
const DAY_STEPS = [1, 2, 7, 14, 31] as const;

export function dayStep(unitsPerDay: number, minLabelUnits: number): number {
  return DAY_STEPS.find((step) => unitsPerDay * step >= minLabelUnits) ?? 31;
}

/** Indices in [first, last] whose day falls on the step; `days` are "YYYY-MM-DD". */
export function dayTicks(days: string[], first: number, last: number, step: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, first); i <= Math.min(days.length - 1, last); i++) {
    if ((Number(days[i].slice(8, 10)) - 1) % step === 0) out.push(i);
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
  /** Points in a year: 12 on a month axis, 365 on a day axis. */
  perYear = 12,
): { year: string; at: number }[] {
  const every = unitsPerMonth * perYear >= minLabelUnits ? 1 : 2;
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

/**
 * The x-axis labels of a goal's chart, from `start` to `end` (month keys),
 * as month offsets from `start`. A chart spanning three years or less is
 * labelled by quarter (Apr, Jul, Oct, and the year itself on January):
 * labelled by year alone, a goal fifteen months long carried one label in
 * the middle and nothing to read the rest by. Longer charts keep calendar
 * years, stepped so they never crowd. A label never sits on the first month,
 * where it would print half off the left edge.
 */
export function goalAxisTicks(start: string, end: string): { at: number; label: string }[] {
  const index = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
  const first = index(start);
  const last = index(end);
  const ticks: { at: number; label: string }[] = [];
  if (last - first <= 36) {
    for (let i = first + 1; i <= last; i += 1) {
      const month = i % 12;
      if (month % 3 !== 0) continue;
      const year = Math.floor(i / 12);
      ticks.push({
        at: i - first,
        label: month === 0 ? String(year) : new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
      });
    }
    return ticks;
  }
  const firstYear = Math.floor(first / 12) + 1;
  const lastYear = Math.floor(last / 12);
  const span = lastYear - firstYear;
  const step = span <= 6 ? 1 : span <= 12 ? 2 : span <= 30 ? 5 : 10;
  for (let yr = Math.ceil(firstYear / step) * step; yr <= lastYear; yr += step) {
    ticks.push({ at: yr * 12 - first, label: String(yr) });
  }
  return ticks;
}
