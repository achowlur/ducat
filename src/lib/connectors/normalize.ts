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
