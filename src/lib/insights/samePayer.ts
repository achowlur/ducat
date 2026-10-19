import { nameWords, PAY_WORDS } from '../payeeWords';
import { median } from './stats';

/**
 * One employer paid under more than one descriptor.
 *
 * A bank renames a paycheck's descriptor ("Acme Payroll direct dep" becomes
 * "Acme Payroll") while the employer stays the same. Pay judged per payer
 * string then read the old name as a payer whose paychecks STOPPED and the
 * new one as the job that replaced it, and the working-out named a job change
 * that never happened. The recurring detector met the same renaming in
 * charges and follows one plan across it (recurring.ts, continues); this is
 * that rule for pay.
 *
 * A payer string CONTINUES an earlier one when:
 * - they share a word of the payer's NAME (payeeWords.ts: never the bank's
 *   bookkeeping, a town, or how pay arrived, PAY_WORDS: "direct", "payroll",
 *   a payroll service's own name), so "direct dep" alone joins nothing;
 * - they never pay in the same pay period: the new name's first payday comes
 *   at least half a pay cycle after the old name's last (two payers paying
 *   in the same weeks are two jobs);
 * - their amounts sit on one pay run: the new name's first paychecks within
 *   RAISE_STEP of the old name's last, the same level or a step like a raise.
 *
 * Every name a chain of continuations went by maps to its NEWEST, so the
 * raise rule (ui/payLevel.ts) and one-off pay (oneOffPay.ts) see one payer.
 */

export interface PayerRow {
  payer: string;
  /** Day it landed, "2026-08-21". */
  date: string;
  amount: number;
}

/** The largest step between the old name's pay and the new name's that still reads as one pay run (a raise). */
const RAISE_STEP = 0.25;
/** Paydays either side of the handover whose middle amount stands for each name's pay there. */
const EDGE = 3;
const DAY_MS = 86_400_000;

const at = (day: string) => Date.parse(`${day}T00:00:00Z`);

interface Run {
  payer: string;
  /** Distinct paydays, oldest first, each day's deposits summed. */
  days: { date: string; total: number }[];
  words: Set<string>;
}

interface Chain {
  runs: Run[];
}

const first = (r: Run) => r.days[0].date;
const last = (r: Run) => r.days[r.days.length - 1].date;
const tailOf = (c: Chain) => c.runs[c.runs.length - 1];

/** The middle gap between paydays, in days; null with one payday. */
function usualGap(days: readonly { date: string }[]): number | null {
  if (days.length < 2) return null;
  const gaps = days.slice(1).map((d, k) => (at(d.date) - at(days[k].date)) / DAY_MS);
  return median(gaps);
}

function continues(chain: Chain, run: Run): boolean {
  const tail = tailOf(chain);
  if (![...run.words].some((w) => tail.words.has(w))) return false;
  const gap = usualGap(tail.days) ?? usualGap(run.days) ?? 0;
  const handover = (at(first(run)) - at(last(tail))) / DAY_MS;
  if (handover <= 0 || handover < 0.5 * gap) return false;
  const before = median(tail.days.slice(-EDGE).map((d) => d.total));
  const after = median(run.days.slice(0, EDGE).map((d) => d.total));
  return Math.abs(after - before) <= RAISE_STEP * Math.max(before, after);
}

/** Every payer string → the name its employer goes by now (itself, unless it was renamed). */
export function payerNames(rows: readonly PayerRow[]): Map<string, string> {
  const byPayer = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const days = byPayer.get(r.payer) ?? new Map<string, number>();
    days.set(r.date, (days.get(r.date) ?? 0) + r.amount);
    byPayer.set(r.payer, days);
  }
  const runs: Run[] = [...byPayer]
    .map(([payer, days]) => ({
      payer,
      days: [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, total]) => ({ date, total })),
      words: new Set(nameWords(payer, PAY_WORDS)),
    }))
    .sort((a, b) => (first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : a.payer < b.payer ? -1 : 1));

  // Each name joins the chain it continues that ended most recently before
  // it; candidates come through the words of names already placed.
  const chains: Chain[] = [];
  const byWord = new Map<string, Chain[]>();
  for (const run of runs) {
    let joined: Chain | null = null;
    for (const word of run.words) {
      for (const chain of byWord.get(word) ?? []) {
        if (joined !== null && last(tailOf(chain)) <= last(tailOf(joined))) continue;
        if (continues(chain, run)) joined = chain;
      }
    }
    if (joined === null) {
      joined = { runs: [run] };
      chains.push(joined);
    } else joined.runs.push(run);
    for (const word of run.words) {
      const list = byWord.get(word) ?? [];
      if (!list.includes(joined)) byWord.set(word, [...list, joined]);
    }
  }

  const names = new Map<string, string>();
  for (const chain of chains) {
    const now = tailOf(chain).payer;
    for (const run of chain.runs) names.set(run.payer, now);
  }
  return names;
}
