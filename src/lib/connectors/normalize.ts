/**
 * Bank-supplied display text, with replacement characters removed.
 *
 * "WELLS FARGO AUTOGRAPH VISA<U+FFFD><U+FFFD> CARD" is what actually arrives:
 * a ® that lost its encoding somewhere upstream. U+FFFD carries no
 * information — it is the marker for a byte that could not be decoded — so
 * the only question is whether the app shows it. It appeared on Overview, in
 * the account filter, on Accounts, and mid-sentence inside the coverage
 * notices, i.e. while explaining why totals were understated.
 *
 * Applied at the CONNECTOR boundary, not at display: every screen and every
 * export reads the stored string, and there is no point storing a character
 * that means "decoding failed".
 */
export function sanitizeBankText(raw: string): string {
  if (!raw.includes('�')) return raw; // untouched unless it has to be
  return raw
    .replace(/�/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Payment processors wrap the merchant's own name: Toast bills "TST*BUCKS",
 * Square "SQ *SORREL", DoorDash "DD *DOORDASH STONEGATE", PayLease
 * "PL*PAYLEASE WEB PMTS", and Slice, Paytronix, SpotOn, GoDaddy Payments,
 * Fivestars, UEP, CL and WL all do the same. The wrapper defeats both jobs
 * this string has — a brand rule for the restaurant never matches, and
 * grouped review buckets every Toast restaurant in town under nothing they
 * have in common. ("CL *CHASE TRAVEL" and "CHASE TRAVEL" were two groups.)
 *
 * Only the wrapper comes off. What the rail implies about the CATEGORY is a
 * separate question answered by rules against the raw description, which
 * keeps the prefix: Toast and Slice are restaurant software, while Square
 * bills salons and retail as readily as cafes.
 *
 * The leading \b is load-bearing: it stops "DD's Discounts" and any other
 * name that merely ends in a token from being cut open. Stripping a PREFIX
 * also keeps the result a contiguous run of the original, which is what
 * lets it go on working as a rule's CONTAINS value.
 */
const PROCESSOR_PREFIX = /\b(tst|sq|slice|dd|py|spo|gdp|fiv|uep|pl|cl|wl)\s*\*\s*/g;

/**
 * Conservative merchant normalization: lowercase, unwrap payment-processor
 * prefixes, strip reference/card number noise, collapse whitespace.
 * Deliberately does not try to be clever — rules can re-categorize what
 * this misses.
 */
export function normalizeMerchant(raw: string): string {
  return raw
    .toLowerCase()
    .replace(PROCESSOR_PREFIX, ' ')
    .replace(/#\s*\d+/g, ' ') // "#1234" store/check numbers
    .replace(/\b\d{5,}\b/g, ' ') // long card/reference number runs
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ') // embedded dates
    .replace(/\s+/g, ' ')
    .trim();
}
