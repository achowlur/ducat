const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$11,668.85" / "−$10,385.32" (true minus sign, ledger style). */
export function money(n: number): string {
  return n < 0 ? `−$${usd.format(Math.abs(n))}` : `$${usd.format(n)}`;
}

/** "11,668.85" / "−10,385.32" for table columns where $ would repeat. */
export function amount(n: number): string {
  return n < 0 ? `−${usd.format(Math.abs(n))}` : usd.format(n);
}

/** "+2.34%" / "−0.26%" from a fraction like 0.0234. */
export function pct(fraction: number): string {
  const sign = fraction < 0 ? "−" : "+";
  return `${sign}${Math.abs(fraction * 100).toFixed(2)}%`;
}

/** Period key "2026-07" → "July 2026". */
export function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-07-12" → short human date "Jul 12". */
export function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Display-only title case for normalized merchant strings ("zelle payment
 * to john smith" → "Zelle Payment To John Smith"). The lowercase original
 * stays untouched in the DB — it's the rule-matching key. Known trade-off:
 * acronyms render as words (CVS → Cvs).
 */
export function titleCase(s: string): string {
  return s.replace(/(^|[\s/\-&.(])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}
