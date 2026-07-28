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
 * Square "SQ *NORTHSIDE BAKERY", DoorDash "DD *DOORDASH BLUEBARN", PayLease
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
 * Where the merchant's name ends and the bank's bookkeeping begins.
 *
 * A padded bank descriptor is columns: MERCHANT, transaction type, reference,
 * account holder. Everything after the type belongs to the bank and the
 * account, not the payee, and it VARIES per charge — which quietly shatters
 * one payee into many merchants. Measured on 2638 real transactions: "web
 * pmts" produced 18 distinct merchant strings for a single rent portal, one
 * per reference code, and Verizon arrived under three depending on whether the
 * row came from the feed (which supplies a clean payee) or a CSV (which does
 * not). 713 of 1381 distinct merchants ran to four words or more.
 *
 * Truncating rather than deleting keeps the result a contiguous PREFIX of the
 * original, the same property `payeeKey` needs and for the same reason: a
 * merchant string has to stay findable in the text it came from, or every rule
 * written against it silently stops matching.
 *
 * Evidence-based and deliberately short. Each entry was observed in the real
 * data; guessing at more would risk cutting a genuine name in half.
 * "paymentrec urring" is not a typo — Wells Fargo splits "PAYMENT RECURRING"
 * across a column boundary.
 */
const TRANSACTION_TYPE = /\b(paymentrec urring|payment recurring|web pmts|payroll|epay|auto pay|autopay)\b/;

/** Below this the prefix is not a name, so the marker is part of one. */
const MIN_MERCHANT = 3;

/**
 * Whether a string carries one of the bank's bookkeeping markers.
 *
 * Exported so the repair can ask the question without owning a second copy of
 * the list. A connector sometimes supplies a PAYEE the bank has already mangled
 * — "HarborwayMgmt WEB BQXRT" for a description that plainly reads
 * "PL*HarborwayMgmt WEB PMTS 070226 BQXRT8 Marlowe Brennan" — and re-running
 * the normalizer over that payee can never recover what it never contained.
 * The description can, but only where it is demonstrably the better source.
 */
export function hasTransactionType(raw: string): boolean {
  return TRANSACTION_TYPE.test(raw.toLowerCase());
}

/**
 * Conservative merchant normalization: lowercase, unwrap payment-processor
 * prefixes, strip reference/card number noise, cut the bank's bookkeeping
 * columns, collapse whitespace. Deliberately does not try to be clever —
 * rules can re-categorize what this misses.
 */
export function normalizeMerchant(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(PROCESSOR_PREFIX, ' ')
    .replace(/#\s*\d+/g, ' ') // "#1234" store/check numbers
    .replace(/\b\d{5,}\b/g, ' ') // long card/reference number runs
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ') // embedded dates
    .replace(/\s+/g, ' ')
    .trim();

  const marker = TRANSACTION_TYPE.exec(cleaned);
  if (marker === null || marker.index < MIN_MERCHANT) return cleaned;
  return cleaned.slice(0, marker.index).trim();
}
