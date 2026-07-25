/**
 * Resolves a human/bank label to one of the known accounts.
 *
 * Statements and exports never spell an account the way the app stores it —
 * "X12345-0001" or "RETIREMENT IRA" against "RETIREMENT IRA (0002)" — so matching walks
 * from strongest evidence to weakest and REFUSES anything ambiguous. Filing a
 * balance or a transaction under the wrong account corrupts two accounts at
 * once and is invisible afterwards, so a skipped row the caller reports is
 * always the better failure.
 */
export interface MatchableAccount {
  name: string;
  externalId: string;
}

/** Account numbers are masked differently on each side; compare digit tails. */
function digitRuns(value: string): string[] {
  return value.match(/\d{4,}/g) ?? [];
}

function unique<T>(matches: T[]): T | null {
  return matches.length === 1 ? matches[0] : null;
}

export function matchAccount<T extends MatchableAccount>(raw: string, candidates: T[]): T | null {
  const needle = raw.trim().toLowerCase();
  if (needle === '') return null;

  const exact = candidates.find(
    (c) => c.name.toLowerCase() === needle || c.externalId.toLowerCase() === needle,
  );
  if (exact !== undefined) return exact;

  // "X12345-0001" vs "Brokerage Individual (0001)"
  const rawRuns = digitRuns(raw);
  const byDigits = candidates.filter((c) =>
    digitRuns(c.name).some((nameRun) =>
      rawRuns.some((rawRun) => rawRun.endsWith(nameRun) || nameRun.endsWith(rawRun)),
    ),
  );
  if (byDigits.length > 0) return unique(byDigits);

  // "RETIREMENT IRA" vs "RETIREMENT IRA (0002)" — but "Brokerage Individual" matches two
  // accounts, so it stays unresolved rather than picking one.
  const bySubstring = candidates.filter((c) => {
    const name = c.name.toLowerCase();
    return name.includes(needle) || needle.includes(name);
  });
  return unique(bySubstring);
}
