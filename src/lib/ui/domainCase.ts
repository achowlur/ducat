/**
 * Domain suffixes that `titleCase` must NOT capitalise.
 *
 * A dot is a word separator inside a name ("st. louis" → "St. Louis") and part
 * of the token inside a domain, so one rule cannot serve both: merchants came
 * out as "Coursera.Org" and "Link.Com". Only these endings are undone, and
 * only at the end of a word — every other dot keeps the capital it earned.
 */
export const DOMAIN_SUFFIX = /\.(com|org|net|io|co|gov|edu)(?![a-z])/gi;

/** "Coursera.Org" → "Coursera.org". Leaves "St. Louis" alone. */
export function lowercaseDomainSuffix(s: string): string {
  return s.replace(DOMAIN_SUFFIX, (m) => m.toLowerCase());
}
