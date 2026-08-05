import type { ProviderStatusLevel } from './types';

/**
 * The record of the last VERIFIED local backup — the Setting behind
 * /providers' "last local backup" line. Written by scripts/backup-scheduled.ts
 * ONLY after the content fingerprints of the new backup file and the cloud
 * match, never on a failed run, so the age derived here measures "days
 * without a PROVEN local copy" — the number the 2026-08-04 Turso outage made
 * matter — not "days since the task last tried".
 *
 * The row lives in the CLOUD database and is copied byte-identically to the
 * local mirror in the same run (cloud first — the wrapper is that one row's
 * mirror step; evidence in docs/conventions/sync-and-data-ops.md). Cloud
 * placement is deliberate: the phone is this app's primary read, and a backup
 * job that dies quietly is worse than none only if nobody sees it die —
 * a filesystem-derived age could never render on Vercel, where the backups
 * directory does not exist.
 *
 * Same tolerant-parse shape as rates/mortgageRate.ts: a corrupted Setting
 * must never take a page down, it just means "no backup recorded".
 */
export const BACKUP_SETTING_KEY = 'backup.lastRun';

export interface StoredBackupRun {
  /** ISO instant the verified run completed. */
  at: string;
  /** Basename under data/backups/ on the machine that runs the schedule. */
  file: string;
  /** fingerprint-db's WHOLE DATABASE digest, shared by cloud and file. */
  wholeDigest: string;
  /** Total rows the verified backup holds. */
  rows: number;
}

export function parseBackupRun(raw: string | null): StoredBackupRun | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const s = parsed as Record<string, unknown>;
    if (
      typeof s.at !== 'string' ||
      Number.isNaN(Date.parse(s.at)) ||
      typeof s.file !== 'string' ||
      s.file === '' ||
      typeof s.wholeDigest !== 'string' ||
      s.wholeDigest === '' ||
      typeof s.rows !== 'number' ||
      !Number.isInteger(s.rows) ||
      s.rows <= 0
    ) {
      return null;
    }
    return { at: s.at, file: s.file, wholeDigest: s.wholeDigest, rows: s.rows };
  } catch {
    return null;
  }
}

/**
 * `ageDays` — floor of elapsed 24-hour periods since the verified run — is
 * exactly the count of MISSED nightly slots, because the run stamps `at`
 * minutes after its own 23:50 UTC slot: one missed night can only ever read
 * age 1 (elapsed stays under 48h until the second slot passes), two read
 * age 2, and so on. So the thresholds count nights: one missed night is OK
 * (a machine off overnight — travel makes that routine), the second silent
 * night is the task not firing: WARN. Past a week the feature is not doing
 * the one thing it exists for — surviving an outage with a recent copy — so
 * it escalates to ERROR, the level a failed sync gets. Tighter than
 * staleBalanceDays: 5 on purpose: that watches a third-party feed's
 * publication cadence; this watches our own scheduled task, which has no
 * holidays. (First shipped as WARN > 2, which the review caught firing a
 * night LATER than every document promised — floor-of-elapsed already IS
 * the night count, no headroom needed.)
 */
export const BACKUP_WARN_AFTER_NIGHTS = 1;
export const BACKUP_ERROR_AFTER_NIGHTS = 7;

const DAY_MS = 86_400_000;

export interface BackupSignal {
  status: ProviderStatusLevel;
  /** Missed nightly slots = whole elapsed days; clamped at 0 against clock
   * skew. NOT calendar days — labels like "yesterday" must use
   * calendarDaysAgo, which counts in the display zone. */
  ageDays: number;
  run: StoredBackupRun;
  /** Escalation wording for the page; null while healthy. Deliberately
   * carries no second number: the page already prints the calendar age and
   * the exact instant, and a third count in a different unit beside those
   * two would read as a contradiction. */
  reason: string | null;
}

/**
 * Null when nothing was ever recorded — the FRED precedent: an instance that
 * never ran a scheduled backup (fresh deployment, local-only user) carries no
 * backup signal at all rather than a permanent nag. Once one verified run has
 * been recorded the signal exists forever, and silence escalates.
 */
export function deriveBackupStatus(run: StoredBackupRun | null, now: Date): BackupSignal | null {
  if (run === null) return null;
  const ageDays = Math.max(0, Math.floor((now.getTime() - Date.parse(run.at)) / DAY_MS));
  const status: ProviderStatusLevel =
    ageDays > BACKUP_ERROR_AFTER_NIGHTS ? 'ERROR' : ageDays > BACKUP_WARN_AFTER_NIGHTS ? 'WARN' : 'OK';
  const reason =
    status === 'OK'
      ? null
      : status === 'WARN'
        ? 'More than one night has passed without a verified backup — the nightly task is not completing; check data/backups/backup.log on the machine that runs it.'
        : 'Over a week without a verified backup — the schedule is broken; check data/backups/backup.log on the machine that runs it.';
  return { status, ageDays, run, reason };
}
