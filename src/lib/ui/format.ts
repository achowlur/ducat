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
 * The zone WALL-CLOCK times are shown in. Transaction dates stay pinned to UTC
 * above — deliberately, because the feed mixes noon UTC, midnight Eastern and
 * true instants, so re-zoning them would move correct dates. An event that
 * happened at a real instant is different: "synced at 21:50" is useless if you
 * pressed the button at 5:50pm.
 *
 * `DUCAT_TIMEZONE` comes first because Vercel REFUSES `TZ` as a reserved
 * variable name, so the standard mechanism isn't available where it is most
 * needed. Falling back to the resolved zone means local development needs no
 * configuration at all (it picks up the machine's, honouring `TZ` if set), while
 * Vercel runs functions in UTC until told otherwise — see DEPLOY.md.
 */
const DISPLAY_TZ =
  process.env.DUCAT_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * An anomaly's magnitude as a RANK: "higher than 96% of your Dining".
 *
 * Replaces "9.6× typical", which invited reading the median as what a dinner
 * costs. In a heavy-tailed category it is nothing like it — 56% of this
 * database's Dining transactions are under $51.83 against a $43.75 median, so a
 * perfectly ordinary $189.2 dinner rendered as "4.3× typical".
 *
 * Rounds DOWN so the claim is never bigger than the data supports, and says
 * "all" rather than "100%" when nothing in the history was larger. Undefined
 * covers rows stored before the field existed, which regeneration replaces.
 */
export function higherThan(percentileOfHistory: number | undefined, what: string): string {
  if (percentileOfHistory === undefined || percentileOfHistory <= 0) return `unusual for ${what}`;
  if (percentileOfHistory >= 1) return `higher than all ${what}`;
  return `higher than ${Math.floor(percentileOfHistory * 100)}% of ${what}`;
}

/**
 * An instant as local wall-clock, always carrying its zone: "Jul 26, 5:50 PM
 * EDT". The zone name is not decoration — without it a UTC timestamp reads as
 * local and is silently four or five hours wrong.
 */
export function dateTime(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: DISPLAY_TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
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
