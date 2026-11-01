/**
 * The zone WALL-CLOCK times are shown in, and the calendar day an instant
 * falls on there. Transaction dates stay pinned to UTC (ui/format.ts) because
 * the feed mixes noon UTC, midnight Eastern and true instants, so re-zoning
 * them would move correct dates. An event that happened at a real instant is
 * different: "synced at 21:50" is useless if you pressed the button at
 * 5:50pm, and a bank's balance stamped 9:45pm Eastern is that evening's.
 *
 * `DUCAT_TIMEZONE` comes first because Vercel REFUSES `TZ` as a reserved
 * variable name, so the standard mechanism isn't available where it is most
 * needed. Falling back to the resolved zone means local development needs no
 * configuration at all (it picks up the machine's, honouring `TZ` if set),
 * while Vercel runs functions in UTC until told otherwise — see DEPLOY.md.
 *
 * `||`, not `??`: `.env.example` ships the variable EMPTY, and `??` kept the
 * empty string, which every Intl call then refused as a time zone. A fresh
 * install's first sync took down every page that prints an instant.
 *
 * It lives here, under lib, because the insights engine reads it too: a
 * brokerage's balance belongs to the market day it values, which is a local
 * day (insights/netWorth.ts marketDaySnapshots), and the engine cannot
 * reach up into the UI for it.
 */
export const DISPLAY_TZ =
  process.env.DUCAT_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The calendar day an INSTANT falls on in the display zone, as "2026-10-16": a
 * bank's balance stamped 9:45pm Eastern is that evening's close, though it is
 * already the next day in UTC.
 */
export function localDayKey(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ });
}
