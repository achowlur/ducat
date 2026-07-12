export interface TransferCandidate {
  id: string;
  accountId: string;
  date: Date;
  amount: number; // signed
  transferPairId: string | null;
}

export interface TransferPair {
  outId: string; // the negative side
  inId: string; // the positive side
}

const DAY_MS = 86_400_000;

/**
 * Links transfers between the user's own accounts: exact opposite amounts,
 * different accounts, dates within `windowDays` (banks post the two sides
 * on different days). Greedy nearest-date matching; each transaction pairs
 * at most once. Already-paired transactions never re-pair.
 */
export function detectTransferPairs(
  candidates: TransferCandidate[],
  windowDays = 4,
): TransferPair[] {
  const unpaired = candidates.filter((t) => t.transferPairId === null && t.amount !== 0);
  const outs = unpaired
    .filter((t) => t.amount < 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const ins = unpaired
    .filter((t) => t.amount > 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const usedIns = new Set<string>();
  const pairs: TransferPair[] = [];
  // Cents-exact matching — floating point must not decide money questions.
  const cents = (n: number) => Math.round(n * 100);

  for (const out of outs) {
    let best: { id: string; distance: number } | null = null;
    for (const candidate of ins) {
      if (usedIns.has(candidate.id)) continue;
      if (candidate.accountId === out.accountId) continue;
      if (cents(candidate.amount) !== -cents(out.amount)) continue;
      const distance = Math.abs(candidate.date.getTime() - out.date.getTime());
      if (distance > windowDays * DAY_MS) continue;
      if (best === null || distance < best.distance) {
        best = { id: candidate.id, distance };
      }
    }
    if (best !== null) {
      usedIns.add(best.id);
      pairs.push({ outId: out.id, inId: best.id });
    }
  }
  return pairs;
}
