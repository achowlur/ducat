import { describe, expect, it } from 'vitest';
import {
  BACKUP_ERROR_AFTER_NIGHTS,
  BACKUP_WARN_AFTER_NIGHTS,
  deriveBackupStatus,
  parseBackupRun,
} from './backup';

const RUN = {
  at: '2026-08-04T23:52:11.000Z',
  file: 'ducat-2026-08-04-1952.db',
  wholeDigest: 'a1dace9026c857a1',
  rows: 1931,
};

/** The stamp sits minutes after the nightly slot, so N whole days after it
 * is exactly the state after N missed nightly slots. */
const afterMissedNights = (n: number) => new Date(Date.parse(RUN.at) + n * 86_400_000 + 3_600_000);

describe('parseBackupRun', () => {
  it('round-trips a stored run', () => {
    expect(parseBackupRun(JSON.stringify(RUN))).toEqual(RUN);
  });

  it('tolerates garbage without throwing — a corrupted Setting reads as "never recorded"', () => {
    for (const raw of [null, '', 'not json', '42', '{}', '[]', JSON.stringify({ ...RUN, at: 'yesterday' })]) {
      expect(parseBackupRun(raw)).toBeNull();
    }
  });

  it('refuses a run with no rows or an empty digest — those never verify', () => {
    expect(parseBackupRun(JSON.stringify({ ...RUN, rows: 0 }))).toBeNull();
    expect(parseBackupRun(JSON.stringify({ ...RUN, wholeDigest: '' }))).toBeNull();
  });
});

describe('deriveBackupStatus', () => {
  it('carries no signal at all when nothing was ever recorded — the FRED precedent', () => {
    expect(deriveBackupStatus(null, afterMissedNights(0))).toBeNull();
  });

  it('tolerates exactly one missed night — a machine off overnight is routine', () => {
    for (const nights of [0, BACKUP_WARN_AFTER_NIGHTS]) {
      const s = deriveBackupStatus(RUN, afterMissedNights(nights));
      expect(s?.status).toBe('OK');
      expect(s?.reason).toBeNull();
      expect(s?.ageDays).toBe(nights);
    }
  });

  it('WARNs on the second silent night — the moment the docs promise, not a night later', () => {
    const s = deriveBackupStatus(RUN, afterMissedNights(BACKUP_WARN_AFTER_NIGHTS + 1));
    expect(s?.status).toBe('WARN');
    expect(s?.ageDays).toBe(2);
    expect(s?.reason).toContain('backup.log');
  });

  it('escalates to ERROR past a week of silence', () => {
    expect(deriveBackupStatus(RUN, afterMissedNights(BACKUP_ERROR_AFTER_NIGHTS))?.status).toBe('WARN');
    const s = deriveBackupStatus(RUN, afterMissedNights(BACKUP_ERROR_AFTER_NIGHTS + 1));
    expect(s?.status).toBe('ERROR');
    expect(s?.reason).toContain('week');
  });

  it('clamps clock skew at zero rather than reporting a backup from the future', () => {
    expect(deriveBackupStatus(RUN, afterMissedNights(-1))?.ageDays).toBe(0);
  });
});

describe('the local mirror in the backup signal', () => {
  const mirrored = { ...RUN, localMirror: { status: 'mirrored' as const, detail: null } };
  const refused = {
    ...RUN,
    localMirror: { status: 'refused' as const, detail: 'local changed since it was last mirrored (Setting)' },
  };

  it('round-trips the outcome, and reads a malformed one as absent rather than dropping the whole run', () => {
    expect(parseBackupRun(JSON.stringify(refused))).toEqual(refused);
    expect(parseBackupRun(JSON.stringify({ ...RUN, localMirror: { status: 'maybe' } }))).toEqual(RUN);
  });

  it('states a successful mirror in words, and stays OK', () => {
    const signal = deriveBackupStatus(mirrored, afterMissedNights(0));
    expect(signal?.status).toBe('OK');
    expect(signal?.localMirrorLine).toBe('The local database was updated to match it.');
    expect(signal?.reason).toBeNull();
  });

  // The failure the mirror exists to prevent is the local app quietly reading
  // stale figures; a fresh backup must not hide it behind a green dot.
  it('WARNs on a fresh backup whose mirror did not happen, and says why', () => {
    const signal = deriveBackupStatus(refused, afterMissedNights(0));
    expect(signal?.status).toBe('WARN');
    expect(signal?.localMirrorLine).toBeNull();
    expect(signal?.reason).toContain('NOT updated');
    expect(signal?.reason).toContain('local changed since it was last mirrored (Setting)');
  });

  it("lets an aging backup's own reason lead, since its mirror is just as old", () => {
    const signal = deriveBackupStatus(refused, afterMissedNights(BACKUP_ERROR_AFTER_NIGHTS + 1));
    expect(signal?.status).toBe('ERROR');
    expect(signal?.reason).toContain('Over a week');
  });

  it('adds nothing for a run recorded before the mirror existed', () => {
    const signal = deriveBackupStatus(RUN, afterMissedNights(0));
    expect(signal?.status).toBe('OK');
    expect(signal?.localMirrorLine).toBeNull();
  });
});
