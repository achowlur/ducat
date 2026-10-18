import { basename, join } from 'node:path';
import { BACKUP_FILE } from './retention';

/**
 * Which file `npm run audit:figures` reads: a verified backup, and only ever
 * a COPY of it. The audit regenerates insights on the copy so the figures
 * are this checkout's, which is a write, so it may never point at the live
 * local database or the cloud, and it never reads DATABASE_URL at all.
 *
 * `--from` names a backup; without it, the newest canonical one. A name that
 * is not a canonical `ducat-YYYY-MM-DD-HHMM.db` (data/ducat.db, a .partial,
 * an .unverified quarantine, a libsql URL) is refused: canonical names are
 * earned by verification (retention.ts).
 */
export function auditSource(
  from: string | undefined,
  backupNames: readonly string[],
  dir: string,
): { path: string } | { refusal: string } {
  if (from !== undefined) {
    if (!BACKUP_FILE.test(basename(from))) {
      return { refusal: `${from} is not a verified backup: give a canonical ducat-YYYY-MM-DD-HHMM.db from ${dir}` };
    }
    return { path: from };
  }
  // Canonical names sort chronologically, which is why they are canonical.
  const names = backupNames.filter((n) => BACKUP_FILE.test(n)).sort();
  if (names.length === 0) return { refusal: `No verified backup in ${dir}. The nightly backup:scheduled writes one.` };
  return { path: join(dir, names[names.length - 1]) };
}
