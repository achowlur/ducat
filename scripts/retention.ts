/**
 * Backup retention: which files under data/backups/ stay, decided from
 * filenames alone. The policy the backlog agreed: roughly 14 dailies, one per
 * month beyond. Made precise here as:
 *
 *  - every file dated within the 14 most recent DISTINCT DATES present is
 *    kept — dates, not files, so a manual backup taken beside the scheduled
 *    one is never deleted the same night; and distinct dates present, not
 *    "the last 14 calendar days", so a machine that was off for a week still
 *    holds 14 restore points rather than 7;
 *  - beyond those dates, the NEWEST file of each calendar month is kept and
 *    the rest are removed. Once a month has fully aged out of the daily
 *    window its keeper is that month's last backup, and never changes again.
 *
 * Only names matching the exact `ducat-YYYY-MM-DD-HHMM.db` pattern are ever
 * candidates — everything else in the directory (backup.log, a hand-renamed
 * ducat-superseded.db, anything foreign) is reported as ignored and never
 * touched. Pure function; the wrapper applies the plan and logs every
 * removal by name.
 */

/** The one place the backup filename shape lives — writer and parser both. */
export const BACKUP_FILE = /^ducat-(\d{4}-\d{2}-\d{2})-(\d{4})\.db$/;

/** Local time, minute resolution, sortable: ducat-2026-07-26-2145.db */
export function backupFileName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ducat-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.db`;
}

export const DAILY_DATES_KEPT = 14;

export interface RetentionPlan {
  keep: string[];
  remove: string[];
  /** Not dated backups — never touched, listed so the log can say so. */
  ignored: string[];
}

export function planRetention(fileNames: string[]): RetentionPlan {
  const dated: { name: string; date: string; time: string }[] = [];
  const ignored: string[] = [];
  for (const name of fileNames) {
    const m = BACKUP_FILE.exec(name);
    if (m === null) ignored.push(name);
    else dated.push({ name, date: m[1], time: m[2] });
  }

  const dates = [...new Set(dated.map((f) => f.date))].sort().reverse();
  const dailyDates = new Set(dates.slice(0, DAILY_DATES_KEPT));

  // Beyond the daily window, the newest file of each month survives. Fixed-width
  // date+time strings sort lexicographically, so "newest" is the largest key.
  const monthKeeper = new Map<string, string>();
  const older = dated
    .filter((f) => !dailyDates.has(f.date))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  for (const f of older) monthKeeper.set(f.date.slice(0, 7), f.name);

  const keep: string[] = [];
  const remove: string[] = [];
  for (const f of dated) {
    if (dailyDates.has(f.date) || monthKeeper.get(f.date.slice(0, 7)) === f.name) keep.push(f.name);
    else remove.push(f.name);
  }
  return { keep, remove, ignored };
}
