import { GOAL_RATE_MONTHS } from './goals';
import { isComparableBaseline } from './pace';
import { periodEndExclusive, periodStart } from './periods';

/**
 * The complete months a projection averages: the savings goal's pace, house
 * readiness and the runway all read the last six (GOAL_RATE_MONTHS), and
 * all three used to average every one of them. A month from before a card's
 * records begin holds none of that card's spending, so it reads cheaper than
 * it was, and its saving richer.
 *
 * So a month reaching back over too few of today's accounts to be compared
 * with today is LEFT OUT, by the pace call's own rule (isComparableBaseline:
 * two thirds), so two answers to "is this month comparable?" never meet on
 * one screen. The window does not reach further back to replace it: older
 * months miss more, and hold older pay. A month kept that still predates an
 * account's records entirely is named, with the direction it leans, since
 * the average takes it as whole. A month an account STARTED in holds that
 * account's spending from its first day, which is complete data, and is not
 * named (coverage.ts: a mid-period start is not a shortfall).
 *
 * `firstRecords` is each account's earliest transaction (null with none),
 * investment accounts already left out: they are a closed box, and no total
 * here holds their rows (ui/coverage.ts).
 */

export interface DroppedMonth {
  period: string;
  /** Accounts whose records begin after this month starts. */
  missing: number;
  total: number;
}

export interface RecentMonths {
  /** The months averaged, oldest first. */
  used: string[];
  /** Months in the window left out as not comparable with today. */
  dropped: DroppedMonth[];
  /** Months averaged that hold nothing from some account: the average reads them as whole. */
  short: string[];
}

export function recentMonths(
  completePeriods: readonly string[],
  firstRecords: readonly (Date | null)[],
  size: number = GOAL_RATE_MONTHS,
): RecentMonths {
  const window = [...completePeriods].sort().slice(-size);
  const total = firstRecords.length;
  const used: string[] = [];
  const dropped: DroppedMonth[] = [];
  const short: string[] = [];
  for (const period of window) {
    const start = periodStart(period).getTime();
    const end = periodEndExclusive(period).getTime();
    const covered = firstRecords.filter((d) => d !== null && d.getTime() <= start).length;
    if (!isComparableBaseline({ covered, total })) {
      dropped.push({ period, missing: total - covered, total });
      continue;
    }
    used.push(period);
    if (firstRecords.some((d) => d === null || d.getTime() >= end)) short.push(period);
  }
  return { used, dropped, short };
}
