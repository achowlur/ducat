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

/** "2026-07-12" → short human date "Jul 12". */
export function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
