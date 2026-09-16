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
  /**
   * Whether the same run made the machine's local database a copy of the
   * verified backup (scripts/mirrorLocal.ts). Absent on runs recorded before
   * the mirror existed. `detail` says why when it did not happen.
   */
  localMirror?: LocalMirrorOutcome;
}

export interface LocalMirrorOutcome {
  status: 'mirrored' | 'refused' | 'failed';
  detail: string | null;
}

/** Tolerant like the rest: a malformed mirror field is treated as absent. */
function parseLocalMirror(value: unknown): LocalMirrorOutcome | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const m = value as Record<string, unknown>;
  if (m.status !== 'mirrored' && m.status !== 'refused' && m.status !== 'failed') return undefined;
  if (m.detail !== null && typeof m.detail !== 'string') return undefined;
  return { status: m.status, detail: m.detail };
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
    const localMirror = parseLocalMirror(s.localMirror);
    return {
      at: s.at,
      file: s.file,
      wholeDigest: s.wholeDigest,
      rows: s.rows,
      ...(localMirror === undefined ? {} : { localMirror }),
    };
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
  /** The local mirror stated in words when it happened; null when the run
   * predates the mirror or the mirror did not happen (then `reason` says so). */
  localMirrorLine: string | null;
}

/**
 * Null when nothing was ever recorded — the FRED precedent: an instance that
 * never ran a scheduled backup (fresh deployment, local-only user) carries no
 * backup signal at all rather than a permanent nag. Once one verified run has
 * been recorded the signal exists forever, and silence escalates.
 *
 * A backup whose local mirror did not happen is at least WARN even when it is
 * fresh: the local app is then reading data that is out of date, which is the
 * failure the mirror exists to prevent, and it was invisible for weeks before.
 * An aging backup's own reason still leads — its mirror is just as old.
 */
export function deriveBackupStatus(run: StoredBackupRun | null, now: Date): BackupSignal | null {
  if (run === null) return null;
  const ageDays = Math.max(0, Math.floor((now.getTime() - Date.parse(run.at)) / DAY_MS));
  const ageStatus: ProviderStatusLevel =
    ageDays > BACKUP_ERROR_AFTER_NIGHTS ? 'ERROR' : ageDays > BACKUP_WARN_AFTER_NIGHTS ? 'WARN' : 'OK';
  const ageReason =
    ageStatus === 'OK'
      ? null
      : ageStatus === 'WARN'
        ? 'More than one night has passed without a verified backup — the nightly task is not completing; check data/backups/backup.log on the machine that runs it.'
        : 'Over a week without a verified backup — the schedule is broken; check data/backups/backup.log on the machine that runs it.';

  const mirror = run.localMirror;
  const mirrorMissed = mirror !== undefined && mirror.status !== 'mirrored';
  const status: ProviderStatusLevel = mirrorMissed && ageStatus === 'OK' ? 'WARN' : ageStatus;
  const reason =
    ageReason ??
    (mirrorMissed
      ? `The local database was NOT updated to match this backup, so the local app shows out-of-date figures: ${mirror.detail ?? 'no reason was recorded'}.`
      : null);
  const localMirrorLine = mirror?.status === 'mirrored' ? 'The local database was updated to match it.' : null;
  return { status, ageDays, run, reason, localMirrorLine };
}
