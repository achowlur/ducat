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
 * Conservative merchant normalization: lowercase, strip reference/card
 * number noise, collapse whitespace. Deliberately does not try to be
 * clever — rules can re-categorize what this misses.
 */
export function normalizeMerchant(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/#\s*\d+/g, ' ') // "#1234" store/check numbers
    .replace(/\b\d{5,}\b/g, ' ') // long card/reference number runs
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ') // embedded dates
    .replace(/\s+/g, ' ')
    .trim();
}
