/**
 * Which words of a merchant string NAME the payee, as opposed to the bank's
 * bookkeeping around it or the town it sits in.
 *
 * One definition for the two places that relate payees by a shared word:
 * grouped review's suggestions (sync/groupSuggest.ts) and the recurring
 * detector following one plan across a renamed descriptor
 * (insights/recurring.ts). Both learned the same lesson separately, a town
 * shared by two unrelated businesses: grouped review guessed a category from
 * a town name, and the detector joined a gas station and a restaurant in one
 * town into a "plan".
 */

/** Words that are the bank's bookkeeping rather than the payee's name. */
export const BOOKKEEPING = new Set([
  'purchase', 'authorized', 'recurring', 'payment', 'debit', 'credit', 'card', 'online', 'transfer', 'check',
  'deposit', 'withdrawal', 'atm', 'pos', 'ach', 'web', 'pmts', 'llc', 'inc', 'corp', 'company', 'the', 'and',
  'store', 'https', 'www', 'com', 'net', 'org',
]);

/** Words of place, which a descriptor's town and state are made of, never of what was bought. */
const PLACE = new Set([
  'north', 'south', 'east', 'west', 'beach', 'springs', 'spring', 'city', 'county', 'park', 'lake', 'heights',
  'valley', 'island', 'port', 'harbor', 'harbour', 'village', 'town', 'center', 'centre', 'downtown', 'saint',
  'fort', 'mount', 'new', 'york', 'jersey', 'florida', 'texas', 'california', 'carolina', 'virginia', 'brooklyn',
  'manhattan', 'queens', 'boston', 'chicago', 'miami', 'seattle', 'austin', 'denver',
]);

/** A string's words of letters, lowercased; digits and punctuation split them. */
export const letterWords = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter((w) => w.length > 1);

/** The words of a payee's NAME: its first two, past the bank's bookkeeping, at least four letters, not a place. */
export function nameWords(key: string): string[] {
  const w = letterWords(key).filter((x) => !BOOKKEEPING.has(x));
  return [...new Set(w.slice(0, 2))].filter((x) => x.length >= 4 && !PLACE.has(x));
}
