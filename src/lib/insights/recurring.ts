import type { RecurringCadence, RecurringChargePayload } from '../../types/contracts';
import { nameWords } from '../payeeWords';
import { median, round2 } from './stats';
import type { TxnData } from './types';

export interface RecurringOptions {
  /** Minimum occurrences before a merchant counts as recurring. */
  minOccurrences: number;
  /** Fraction of the median amount an occurrence may deviate and still match. */
  amountTolerance: number;
  /** Fraction of occurrences that must match cadence and amount checks. */
  matchRatio: number;
  /** Relative increase of the last charge over prior median that flags a price rise. */
  priceIncreaseThreshold: number;
}

export const DEFAULT_RECURRING_OPTIONS: RecurringOptions = {
  minOccurrences: 3,
  amountTolerance: 0.25,
  matchRatio: 0.8,
  priceIncreaseThreshold: 0.02,
};

const DAY_MS = 86_400_000;

/**
 * Recurring, but NOT subscriptions.
 *
 * Rent and taxes arrive on a cadence, in consistent amounts, from a stable
 * descriptor — the exact shape the detector hunts for — but nobody manages
 * them from a subscriptions list, and listing them buries the two or three
 * things actually worth cancelling.
 *
 * This is also what settles the rent PORTAL. Zego (formerly PayLease) billed
 * $7.88 every month, which has the shape of a subscription and the substance
 * of paying rent: it is the convenience fee on a rent payment, not a service
 * with a plan. Categorising it as Rent & Housing is right whether a portal
 * bills the fee (as here) or the whole rent (as it does for others) — and
 * excluding the category is what stops it being reported as something you
 * could cancel.
 */
export const NOT_SUBSCRIPTION_CATEGORIES = new Set(['Rent & Housing', 'Taxes']);

const CADENCE_BANDS: { cadence: RecurringCadence; min: number; max: number }[] = [
  { cadence: 'WEEKLY', min: 5.5, max: 8.5 },
  { cadence: 'BIWEEKLY', min: 12, max: 16 },
  { cadence: 'MONTHLY', min: 26, max: 35 },
  { cadence: 'QUARTERLY', min: 80, max: 100 },
  { cadence: 'YEARLY', min: 330, max: 400 },
];

/**
 * The longest gap the detector itself still reads as `cadence`. A charge
 * absent for longer than this has MISSED its billing date by the detector's
 * own measure (health/detectedSubscriptions.ts, missedCharge), so "missed"
 * needs no second tolerance of its own.
 */
export function longestGapDays(cadence: RecurringCadence): number {
  return CADENCE_BANDS.find((b) => b.cadence === cadence)!.max;
}

function cadenceOf(medianGapDays: number): RecurringCadence | null {
  const band = CADENCE_BANDS.find((b) => medianGapDays >= b.min && medianGapDays <= b.max);
  return band?.cadence ?? null;
}

/** What the detector's gates make of one series of charges. */
interface SeriesShape {
  cadence: RecurringCadence;
  medianGap: number;
}

/**
 * The detector's gates, in order: enough charges, a median gap inside a
 * cadence band, most gaps near that median, most amounts near theirs. Null
 * when any of them rejects the series. `sorted` is oldest first.
 */
function shapeOf(sorted: TxnData[], options: RecurringOptions): SeriesShape | null {
  if (sorted.length < options.minOccurrences) return null;

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / DAY_MS);
  }
  const medianGap = median(gaps);
  const cadence = cadenceOf(medianGap);
  if (cadence === null) return null;

  const required = Math.ceil(options.matchRatio * gaps.length);
  const regularGaps = gaps.filter((g) => Math.abs(g - medianGap) <= medianGap * 0.45).length;
  if (regularGaps < required) return null;

  const amounts = sorted.map((t) => -t.amount);
  const medianAmount = median(amounts);
  if (medianAmount <= 0) return null;
  const consistent = amounts.filter(
    (a) => Math.abs(a - medianAmount) <= medianAmount * options.amountTolerance,
  ).length;
  if (consistent < Math.ceil(options.matchRatio * amounts.length)) return null;

  return { cadence, medianGap };
}

/** One merchant string's charges, oldest first. */
interface Run {
  merchant: string;
  rows: TxnData[];
  words: Set<string>;
}

/** Runs judged to be one plan billed under successive descriptors. */
interface Chain {
  runs: Run[];
  rows: TxnData[];
}

const firstAt = (rows: TxnData[]) => rows[0].date.getTime();
const lastAt = (rows: TxnData[]) => rows[rows.length - 1].date.getTime();

/**
 * Whether `run` is the same plan as `chain`, billed under a new descriptor.
 *
 * Banks rename a biller's descriptor mid-plan: one monthly plan reached the
 * detector as several merchant strings over the years, and the page listed
 * each long enough to qualify as a separate subscription (a name only one
 * charge long was listed nowhere). A continuation has to look like one: the new name
 * starts after the old one's last charge (overlapping runs are two plans),
 * on the same account, at about the same price, sharing a word of the payee's
 * NAME (payeeWords.ts: never the town, which joined a gas station and a
 * restaurant into a quarterly "plan"), and the joined series still passes
 * every gate WITH the handover gap reading like any other cycle (a pause and
 * then a new plan is two plans).
 */
function continues(chain: Chain, run: Run, options: RecurringOptions): boolean {
  const tail = chain.runs[chain.runs.length - 1];
  if (lastAt(chain.rows) >= firstAt(run.rows)) return false;
  if (chain.rows[chain.rows.length - 1].accountId !== run.rows[0].accountId) return false;
  if (![...run.words].some((w) => tail.words.has(w))) return false;
  const before = median(tail.rows.map((t) => -t.amount));
  const after = median(run.rows.map((t) => -t.amount));
  if (Math.abs(before - after) > Math.max(before, after) * options.amountTolerance) return false;
  const shape = shapeOf([...chain.rows, ...run.rows], options);
  if (shape === null) return false;
  const handover = (firstAt(run.rows) - lastAt(chain.rows)) / DAY_MS;
  return Math.abs(handover - shape.medianGap) <= shape.medianGap * 0.45;
}

/**
 * Detects merchants charged on a regular cadence with consistent amounts.
 * Only OUTFLOW transactions participate (transfers and income never do).
 * Returns one payload per recurring PLAN, keyed by its newest lowercased
 * merchant; a plan the bank billed under earlier descriptors names them in
 * `aliases` (continues, above).
 */
export function detectRecurringCharges(
  txns: TxnData[],
  options: RecurringOptions = DEFAULT_RECURRING_OPTIONS,
): Map<string, RecurringChargePayload> {
  const byMerchant = new Map<string, TxnData[]>();
  // How far each account's records reach, over EVERY row (an inflow or a
  // transfer proves the account was still being recorded as well as a charge).
  const newestByAccount = new Map<string, number>();
  for (const t of txns) {
    const newest = newestByAccount.get(t.accountId);
    if (newest === undefined || t.date.getTime() > newest) newestByAccount.set(t.accountId, t.date.getTime());
    if (t.flow !== 'OUTFLOW') continue;
    if (t.categoryName !== null && NOT_SUBSCRIPTION_CATEGORIES.has(t.categoryName)) continue;
    const merchant = t.normalizedMerchant.trim().toLowerCase();
    if (merchant === '') continue;
    const list = byMerchant.get(merchant) ?? [];
    list.push(t);
    byMerchant.set(merchant, list);
  }

  // Each run joins the chain that ended most recently before it starts and
  // that it continues; otherwise it starts its own. Candidates come through
  // the words of each chain's newest name, so a run is only ever weighed
  // against chains it shares a word with.
  const runs: Run[] = [...byMerchant]
    .map(([merchant, list]) => ({
      merchant,
      rows: [...list].sort((a, b) => a.date.getTime() - b.date.getTime()),
      words: new Set(nameWords(merchant)),
    }))
    .sort((a, b) => firstAt(a.rows) - firstAt(b.rows) || (a.merchant < b.merchant ? -1 : 1));
  const chains: Chain[] = [];
  const byWord = new Map<string, Chain[]>();
  for (const run of runs) {
    let joined: Chain | null = null;
    for (const word of run.words) {
      for (const chain of byWord.get(word) ?? []) {
        if (joined !== null && lastAt(chain.rows) <= lastAt(joined.rows)) continue;
        if (continues(chain, run, options)) joined = chain;
      }
    }
    if (joined === null) {
      joined = { runs: [run], rows: run.rows };
      chains.push(joined);
    } else {
      joined.runs.push(run);
      joined.rows = [...joined.rows, ...run.rows];
    }
    for (const word of run.words) byWord.set(word, [...(byWord.get(word) ?? []), joined]);
  }

  const result = new Map<string, RecurringChargePayload>();
  for (const { runs: named, rows: sorted } of chains) {
    const shape = shapeOf(sorted, options);
    if (shape === null) continue;
    // Following a plan across names never DISCOVERS one: some name has to be
    // recurring on its own, or two one-off businesses that happen to look
    // alike would be assembled into a subscription nobody has.
    if (named.length > 1 && !named.some((r) => shapeOf(r.rows, options) !== null)) continue;
    const merchant = named[named.length - 1].merchant;
    const amounts = sorted.map((t) => -t.amount);
    const last = sorted[sorted.length - 1];
    const lastAmount = -last.amount;
    const previousAverage = median(amounts.slice(0, -1));
    result.set(merchant, {
      merchant,
      cadence: shape.cadence,
      averageAmount: round2(median(amounts)),
      lastAmount: round2(lastAmount),
      lastDate: last.date.toISOString().slice(0, 10),
      occurrences: sorted.length,
      previousAverageAmount: round2(previousAverage),
      priceIncreased: lastAmount > previousAverage * (1 + options.priceIncreaseThreshold),
      accountThrough: new Date(newestByAccount.get(last.accountId) ?? last.date.getTime()).toISOString().slice(0, 10),
      ...(named.length > 1 ? { aliases: named.slice(0, -1).map((r) => r.merchant) } : {}),
    });
  }
  return result;
}
