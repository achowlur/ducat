/**
 * What subscription detection MISSED, and why. Read-only: touches nothing.
 *
 * `detectRecurringCharges` needs 3+ occurrences of the same normalized
 * merchant, amounts within 25% of their median, and gaps inside a cadence band
 * (monthly = 26-35 days). Every one of those is a place a real subscription can
 * fall through, and the thresholds are not worth moving on a hunch — this
 * reports each near-miss with the gate that rejected it, so a change can be
 * argued from the list rather than from a guess.
 *
 * Run: npm run subs:audit
 */
import { prisma } from '../src/lib/prisma';
import { detectRecurringCharges, DEFAULT_RECURRING_OPTIONS } from '../src/lib/insights/recurring';
import { median } from '../src/lib/insights/stats';
import { isActive, type DetectedCharge } from '../src/lib/health/detectedSubscriptions';
import type { TxnData } from '../src/lib/insights/types';

const DAY_MS = 86_400_000;
const opts = DEFAULT_RECURRING_OPTIONS;

const CADENCE_BANDS = [
  { cadence: 'WEEKLY', min: 5.5, max: 8.5, perYear: 52 },
  { cadence: 'BIWEEKLY', min: 12, max: 16, perYear: 26 },
  { cadence: 'MONTHLY', min: 26, max: 35, perYear: 12 },
  { cadence: 'QUARTERLY', min: 80, max: 100, perYear: 4 },
  { cadence: 'YEARLY', min: 330, max: 400, perYear: 1 },
] as const;

const money = (n: number): string => `$${n.toFixed(2)}`;

interface Verdict {
  merchant: string;
  occurrences: number;
  medianAmount: number;
  medianGap: number | null;
  lastDate: string;
  /** Which gate rejected it, or null when it is detected. */
  rejectedBy: string | null;
  detail: string;
  /** Rough annual cost if it IS recurring — what a miss is worth. */
  annualised: number;
}

/** The same gates as the detector, in the same order, reporting which one bit. */
function classify(merchant: string, list: TxnData[]): Verdict {
  const sorted = [...list].sort((a, b) => a.date.getTime() - b.date.getTime());
  const amounts = sorted.map((t) => -t.amount);
  const medianAmount = median(amounts);
  const last = sorted[sorted.length - 1];
  const lastDate = last.date.toISOString().slice(0, 10);
  const base: Omit<Verdict, 'rejectedBy' | 'detail' | 'medianGap' | 'annualised'> = {
    merchant,
    occurrences: sorted.length,
    medianAmount,
    lastDate,
  };

  if (sorted.length < opts.minOccurrences) {
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / DAY_MS);
    }
    const g = gaps.length === 0 ? null : median(gaps);
    const band = g === null ? undefined : CADENCE_BANDS.find((b) => g >= b.min && g <= b.max);
    return {
      ...base,
      medianGap: g,
      rejectedBy: 'occurrences',
      detail:
        band === undefined
          ? `only ${sorted.length}, needs ${opts.minOccurrences}`
          : `only ${sorted.length}, needs ${opts.minOccurrences} — but the gaps look ${band.cadence.toLowerCase()}`,
      annualised: band === undefined ? 0 : medianAmount * band.perYear,
    };
  }

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / DAY_MS);
  }
  const medianGap = median(gaps);
  const band = CADENCE_BANDS.find((b) => medianGap >= b.min && medianGap <= b.max);
  if (band === undefined) {
    const nearest = CADENCE_BANDS.reduce((best, b) => {
      const d = Math.min(Math.abs(medianGap - b.min), Math.abs(medianGap - b.max));
      const bd = Math.min(Math.abs(medianGap - best.min), Math.abs(medianGap - best.max));
      return d < bd ? b : best;
    });
    return {
      ...base,
      medianGap,
      rejectedBy: 'cadence',
      detail: `median gap ${medianGap.toFixed(1)}d falls outside every band (nearest ${nearest.cadence} ${nearest.min}-${nearest.max}d)`,
      annualised: 0,
    };
  }

  const required = Math.ceil(opts.matchRatio * gaps.length);
  const regular = gaps.filter((g) => Math.abs(g - medianGap) <= medianGap * 0.45).length;
  if (regular < required) {
    return {
      ...base,
      medianGap,
      rejectedBy: 'irregular gaps',
      detail: `only ${regular}/${gaps.length} gaps within 45% of the ${medianGap.toFixed(1)}d median, needs ${required}`,
      annualised: medianAmount * band.perYear,
    };
  }

  if (medianAmount <= 0) {
    return { ...base, medianGap, rejectedBy: 'non-positive amount', detail: 'median amount <= 0', annualised: 0 };
  }

  const consistent = amounts.filter((a) => Math.abs(a - medianAmount) <= medianAmount * opts.amountTolerance).length;
  const needed = Math.ceil(opts.matchRatio * amounts.length);
  if (consistent < needed) {
    const lo = Math.min(...amounts);
    const hi = Math.max(...amounts);
    return {
      ...base,
      medianGap,
      rejectedBy: 'amount variance',
      detail: `only ${consistent}/${amounts.length} within ${opts.amountTolerance * 100}% of ${money(medianAmount)} (range ${money(lo)}-${money(hi)}), needs ${needed}`,
      annualised: medianAmount * band.perYear,
    };
  }

  return { ...base, medianGap, rejectedBy: null, detail: `${band.cadence.toLowerCase()}`, annualised: medianAmount * band.perYear };
}

async function main(): Promise<void> {
  const rows = await prisma.transaction.findMany({
    select: {
      id: true,
      accountId: true,
      date: true,
      amount: true,
      description: true,
      normalizedMerchant: true,
      flow: true,
      categoryId: true,
      reimbursesId: true,
      category: { select: { name: true, isIncome: true } },
    },
  });
  const txns: TxnData[] = rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    date: r.date,
    amount: Number(r.amount),
    description: r.description,
    normalizedMerchant: r.normalizedMerchant,
    flow: r.flow,
    categoryId: r.categoryId,
    categoryName: r.category?.name ?? null,
    categoryIsIncome: r.category?.isIncome ?? false,
    reimbursesId: r.reimbursesId,
  }));

  const detected = detectRecurringCharges(txns, opts);
  const now = new Date();

  const byMerchant = new Map<string, TxnData[]>();
  for (const t of txns) {
    if (t.flow !== 'OUTFLOW') continue;
    const m = t.normalizedMerchant.trim().toLowerCase();
    if (m === '') continue;
    byMerchant.set(m, [...(byMerchant.get(m) ?? []), t]);
  }

  const verdicts = [...byMerchant]
    .filter(([, list]) => list.length >= 2)
    .map(([m, list]) => classify(m, list));

  const missed = verdicts.filter((v) => v.rejectedBy !== null).sort((a, b) => b.annualised - a.annualised);
  const found = verdicts.filter((v) => v.rejectedBy === null);

  const lapsed = found.filter((v) => {
    const charge = detected.get(v.merchant);
    if (charge === undefined) return false;
    return !isActive(charge as unknown as DetectedCharge, now);
  });

  console.log(`\n${txns.length} transactions, ${byMerchant.size} distinct outflow merchants`);
  console.log(`${found.length} detected as recurring (${lapsed.length} of them lapsed and hidden from the list)`);
  console.log(`${verdicts.length - found.length} merchants with 2+ charges were NOT detected\n`);

  console.log('=== DETECTED ===');
  for (const v of found.sort((a, b) => b.annualised - a.annualised)) {
    const isLapsed = lapsed.includes(v);
    console.log(
      `  ${money(v.medianAmount).padStart(10)} ${v.detail.padEnd(10)} ×${String(v.occurrences).padEnd(3)} ${money(v.annualised).padStart(10)}/yr  ${v.merchant}${isLapsed ? '   [LAPSED — hidden]' : ''}`,
    );
  }

  console.log('\n=== MISSED, ranked by what it would cost a year if real ===');
  const byGate = new Map<string, Verdict[]>();
  for (const v of missed) byGate.set(v.rejectedBy ?? '?', [...(byGate.get(v.rejectedBy ?? '?') ?? []), v]);
  for (const [gate, list] of [...byGate].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  -- rejected by ${gate.toUpperCase()} (${list.length}) --`);
    for (const v of list.slice(0, 15)) {
      const worth = v.annualised > 0 ? `${money(v.annualised)}/yr` : '—';
      console.log(`  ${money(v.medianAmount).padStart(10)} ×${String(v.occurrences).padEnd(3)} ${worth.padStart(11)}  ${v.merchant}`);
      console.log(`  ${' '.repeat(10)}   ${v.detail}  (last ${v.lastDate})`);
    }
    if (list.length > 15) console.log(`  ${' '.repeat(10)}   … and ${list.length - 15} more`);
  }
  console.log('');
}

main().finally(() => prisma.$disconnect());
