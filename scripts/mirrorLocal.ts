/**
 * The local mirror: makes data/ducat.db hold exactly what a VERIFIED backup
 * holds, so the local app reads current data instead of whatever it held the
 * last time somebody copied a file by hand. Shared by `backup:scheduled`
 * (every night, right after the backup is proved equal to the cloud) and
 * `db:mirror` (on demand, and the one-time start).
 *
 * The source is the backup FILE, never Turso: it has already been proved
 * digest-equal to the cloud, so the mirror needs no credentials and no network,
 * and no sync can land half-way through it.
 *
 * ROWS, not the file. Local carries Prisma's migration history and a backup
 * does not (backups are built from the schema, not by migrating); swapping the
 * file would strip that history and the next `prisma migrate dev` would offer
 * to reset the database. So every table is cleared and refilled inside ONE
 * write transaction, the result is fingerprinted INSIDE that transaction, and
 * it commits only if it matches the backup. Anything else rolls back to the
 * database it started with.
 *
 * The objection that kept this from being built (docs/backlog.md) was that
 * overwriting local "would discard anything local-only without being able to
 * tell that it had". It can tell now: after each mirror, local's per-table
 * digests are recorded in MIRROR_STATE_PATH, and the scheduled run refuses
 * whenever local no longer matches them — somebody wrote to local since, and
 * that work would be lost. Only `db:mirror --confirm`, run by a person who has
 * seen both digests, replaces a local that has changed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createClient } from '@libsql/client';
import { clearAndCopy, readPlan } from './copyDatabase';
import { fingerprintOf, type DatabaseFingerprint } from './fingerprintDatabase';
import { BACKUP_FILE } from './retention';

export const LOCAL_DB_PATH = join('data', 'ducat.db');
export const MIRROR_STATE_PATH = join('data', 'backups', 'mirror-state.json');

/** What local looked like the moment it was last made a mirror. */
export interface MirrorState {
  at: string;
  /** Basename of the verified backup local was copied from. */
  source: string;
  overall: string;
  tables: Record<string, string>;
}

export type MirrorOutcome =
  | { status: 'mirrored'; source: string; before: DatabaseFingerprint; after: DatabaseFingerprint; changed: boolean }
  /** Dry run only: every check passed and the copy would go ahead. */
  | { status: 'ready'; source: string; before: DatabaseFingerprint; target: DatabaseFingerprint }
  /** A check said no; local was not touched. */
  | { status: 'refused'; detail: string }
  /** The copy was attempted and rolled back; local was not changed. */
  | { status: 'failed'; detail: string };

const fileUrl = (path: string) => `file:${path.replace(/\\/g, '/')}`;

/** One line, bounded: this text travels into a Setting the phone renders. */
function shortMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const line = text.split(/\r?\n/)[0];
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

export function readMirrorState(path: string = MIRROR_STATE_PATH): MirrorState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const s = parsed as Record<string, unknown>;
    if (typeof s.at !== 'string' || typeof s.source !== 'string' || typeof s.overall !== 'string') return null;
    if (typeof s.tables !== 'object' || s.tables === null) return null;
    const tables: Record<string, string> = {};
    for (const [table, digest] of Object.entries(s.tables as Record<string, unknown>)) {
      if (typeof digest !== 'string') return null;
      tables[table] = digest;
    }
    return { at: s.at, source: s.source, overall: s.overall, tables };
  } catch {
    // An unreadable record proves nothing about local, so it counts as none.
    return null;
  }
}

export function recordMirrorState(
  fp: DatabaseFingerprint,
  source: string,
  path: string = MIRROR_STATE_PATH,
  at: Date = new Date(),
): MirrorState {
  const state: MirrorState = {
    at: at.toISOString(),
    source,
    overall: fp.overall,
    tables: Object.fromEntries(Object.entries(fp.tables).map(([t, f]) => [t, f.digest])),
  };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

/** Tables whose content differs from the recorded mirror, in either direction. */
export function tablesChangedSince(fp: DatabaseFingerprint, state: MirrorState): string[] {
  const names = new Set([...Object.keys(fp.tables), ...Object.keys(state.tables)]);
  return [...names].filter((t) => fp.tables[t]?.digest !== state.tables[t]);
}

export async function mirrorIntoLocal(options: {
  sourcePath: string;
  localPath: string;
  /**
   * The state recorded after the last mirror — the scheduled run refuses
   * unless local still matches it. 'confirmed' means a person saw both
   * digests and accepted replacing whatever local holds.
   */
  unchangedSince: MirrorState | null | 'confirmed';
  dryRun?: boolean;
  log: (line: string) => void;
}): Promise<MirrorOutcome> {
  const { sourcePath, localPath, unchangedSince, dryRun = false, log } = options;
  const source = basename(sourcePath);
  if (!BACKUP_FILE.test(source) || !existsSync(sourcePath)) {
    return {
      status: 'refused',
      detail: `${source} is not a verified backup — only canonical ducat-YYYY-MM-DD-HHMM.db files are mirrored`,
    };
  }
  if (!existsSync(localPath)) {
    return { status: 'refused', detail: 'there is no local database on this machine to update' };
  }

  const src = createClient({ url: fileUrl(sourcePath) });
  const local = createClient({ url: fileUrl(localPath) });
  try {
    const target = await fingerprintOf(src);
    const before = await fingerprintOf(local);

    if (unchangedSince !== 'confirmed') {
      if (unchangedSince === null) {
        return {
          status: 'refused',
          detail: 'local has never been mirrored — run `npm run db:mirror -- --confirm` once to start',
        };
      }
      const changed = tablesChangedSince(before, unchangedSince);
      if (changed.length > 0) {
        return {
          status: 'refused',
          detail:
            `local changed since it was last mirrored (${changed.join(', ')}), so replacing it would lose that work — ` +
            'redo it on the cloud, then run `npm run db:mirror -- --confirm`',
        };
      }
    }

    if (before.overall === target.overall) {
      log(`  local already holds exactly what ${source} holds (${target.overall}) — nothing to copy`);
      return { status: 'mirrored', source, before, after: before, changed: false };
    }
    if (dryRun) {
      log(`  would replace local ${before.overall} with ${source} ${target.overall}`);
      return { status: 'ready', source, before, target };
    }

    // Read the backup BEFORE opening the transaction, so the write lock is held
    // only for the copy itself.
    const plan = await readPlan(src);
    const tx = await local.transaction('write');
    try {
      await clearAndCopy(tx, plan, log);
      const copied = await fingerprintOf(tx);
      if (copied.overall !== target.overall) {
        const differing = Object.keys(target.tables).filter((t) => copied.tables[t]?.digest !== target.tables[t].digest);
        await tx.rollback();
        return {
          status: 'failed',
          detail: `the copy did not match ${source} (${differing.join(', ')}) and was rolled back`,
        };
      }
      await tx.commit();
    } catch (e) {
      if (!tx.closed) await tx.rollback().catch(() => undefined);
      return { status: 'failed', detail: `the copy failed and was rolled back: ${shortMessage(e)}` };
    } finally {
      tx.close();
    }

    const after = await fingerprintOf(local);
    log(`  local ${before.overall} -> ${after.overall} (${source} is ${target.overall})`);
    return { status: 'mirrored', source, before, after, changed: true };
  } finally {
    src.close();
    local.close();
  }
}
