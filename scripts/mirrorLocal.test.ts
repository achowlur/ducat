import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf } from './fingerprintDatabase';
import { mirrorIntoLocal, readMirrorState, recordMirrorState, tablesChangedSince } from './mirrorLocal';

/**
 * The local mirror rewrites the operator's working database every night, so
 * every branch that decides whether it may do so is exercised against real
 * files built from the real migrations: the confirmed start, the refusal when
 * local has never been mirrored, the refusal when local has changed since, the
 * rollback when a copy fails part-way, and the preserved migration history.
 */

const fileUrl = (path: string) => `file:${path.replace(/\\/g, '/')}`;
const quiet = () => undefined;

let dir: string;
let backupPath: string;
let localPath: string;
let statePath: string;

async function migrated(path: string): Promise<Client> {
  const db = createClient({ url: fileUrl(path) });
  const migrations = join(process.cwd(), 'prisma', 'migrations');
  const names = readdirSync(migrations, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of names) await db.executeMultiple(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
  return db;
}

async function fingerprintFile(path: string) {
  const db = createClient({ url: fileUrl(path) });
  try {
    return await fingerprintOf(db);
  } finally {
    db.close();
  }
}

const ROOT = join(tmpdir(), 'ducat-mirror-tests');

beforeAll(() => {
  // The previous run's files: their handles were released when its process
  // exited, so they can be removed now even though they could not be then.
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

beforeEach(async () => {
  dir = mkdtempSync(join(ROOT, 'case-'));
  backupPath = join(dir, 'ducat-2026-09-16-2350.db');
  localPath = join(dir, 'ducat.db');
  statePath = join(dir, 'mirror-state.json');

  // The backup: what the cloud holds, including a parent/child category pair
  // (a self-reference the copy fills in a second pass).
  const backup = await migrated(backupPath);
  await backup.batch(
    [
      "insert into Category (id, name, isIncome) values ('cat-food', 'Food', 0)",
      "insert into Category (id, name, parentId, isIncome) values ('cat-dining', 'Dining', 'cat-food', 0)",
      "insert into Rule (id, priority, matchField, matchOperator, matchValue, setCategoryId, enabled) values ('r1', 50, 'MERCHANT', 'CONTAINS', 'bistro', 'cat-dining', 1)",
      "insert into Setting (key, value) values ('goal', 'cloud value')",
    ],
    'write',
  );
  backup.close();

  // Local: out of date, plus the migration history only a migrated file has.
  const local = await migrated(localPath);
  await local.batch(
    [
      "insert into Category (id, name, isIncome) values ('cat-old', 'Old', 0)",
      "insert into Setting (key, value) values ('goal', 'stale value')",
      'create table _prisma_migrations (id text primary key, migration_name text not null)',
      "insert into _prisma_migrations (id, migration_name) values ('m1', 'init')",
    ],
    'write',
  );
  local.close();
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // On Windows libSQL holds its file handles until the process exits, so
    // this run's files cannot be removed yet; the next run clears them first.
  }
});

describe('mirrorIntoLocal', () => {
  it('on confirmation, makes local hold exactly what the backup holds and keeps its migration history', async () => {
    const target = await fingerprintFile(backupPath);
    const outcome = await mirrorIntoLocal({ sourcePath: backupPath, localPath, unchangedSince: 'confirmed', log: quiet });

    expect(outcome.status).toBe('mirrored');
    expect((await fingerprintFile(localPath)).overall).toBe(target.overall);

    const local = createClient({ url: fileUrl(localPath) });
    try {
      const history = await local.execute('select migration_name from _prisma_migrations');
      expect(history.rows.map((r) => r.migration_name)).toEqual(['init']);
      const child = await local.execute("select parentId from Category where id = 'cat-dining'");
      expect(child.rows[0].parentId).toBe('cat-food');
    } finally {
      local.close();
    }
  });

  it('refuses when local has never been mirrored, and leaves it untouched', async () => {
    const before = await fingerprintFile(localPath);
    const outcome = await mirrorIntoLocal({ sourcePath: backupPath, localPath, unchangedSince: null, log: quiet });

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.detail).toMatch(/never been mirrored/);
    expect((await fingerprintFile(localPath)).overall).toBe(before.overall);
  });

  it('proceeds when local still matches the state recorded after its last mirror', async () => {
    const state = recordMirrorState(await fingerprintFile(localPath), 'ducat-2026-09-15-2350.db', statePath);
    const outcome = await mirrorIntoLocal({ sourcePath: backupPath, localPath, unchangedSince: state, log: quiet });

    expect(outcome.status).toBe('mirrored');
    expect((await fingerprintFile(localPath)).overall).toBe((await fingerprintFile(backupPath)).overall);
  });

  it('refuses when local changed since its last mirror, names the tables, and loses nothing', async () => {
    const state = recordMirrorState(await fingerprintFile(localPath), 'ducat-2026-09-15-2350.db', statePath);
    const local = createClient({ url: fileUrl(localPath) });
    await local.execute("update Setting set value = 'edited locally' where key = 'goal'");
    local.close();
    const changedLocal = await fingerprintFile(localPath);

    const outcome = await mirrorIntoLocal({ sourcePath: backupPath, localPath, unchangedSince: state, log: quiet });

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.detail).toMatch(/changed since it was last mirrored \(Setting\)/);
    expect((await fingerprintFile(localPath)).overall).toBe(changedLocal.overall);
  });

  it('rolls a failed copy back to the database it started with', async () => {
    // A local schema the backup's rows cannot be inserted into: the deletes run
    // first inside the transaction, so only a real rollback leaves them undone.
    const local = createClient({ url: fileUrl(localPath) });
    await local.execute('alter table Rule drop column setFlow');
    local.close();
    const before = await fingerprintFile(localPath);

    const outcome = await mirrorIntoLocal({ sourcePath: backupPath, localPath, unchangedSince: 'confirmed', log: quiet });

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.detail).toMatch(/rolled back/);
    expect((await fingerprintFile(localPath)).overall).toBe(before.overall);
  });

  it('refuses a file that never earned the verified backup name', async () => {
    const unverified = `${backupPath}.unverified`;
    copyFileSync(backupPath, unverified);
    const outcome = await mirrorIntoLocal({ sourcePath: unverified, localPath, unchangedSince: 'confirmed', log: quiet });

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.detail).toMatch(/not a verified backup/);
  });

  it('on a dry run reports that it would mirror and writes nothing', async () => {
    const before = await fingerprintFile(localPath);
    const outcome = await mirrorIntoLocal({
      sourcePath: backupPath,
      localPath,
      unchangedSince: 'confirmed',
      dryRun: true,
      log: quiet,
    });

    expect(outcome.status).toBe('ready');
    expect((await fingerprintFile(localPath)).overall).toBe(before.overall);
  });
});

describe('mirror state', () => {
  it('round-trips, and treats an unreadable record as no record', async () => {
    const fp = await fingerprintFile(localPath);
    const written = recordMirrorState(fp, 'ducat-2026-09-16-2350.db', statePath);
    expect(readMirrorState(statePath)).toEqual(written);
    expect(tablesChangedSince(fp, written)).toEqual([]);

    writeFileSync(statePath, '{ not json');
    expect(readMirrorState(statePath)).toBeNull();
    expect(readMirrorState(join(dir, 'missing.json'))).toBeNull();
  });
});
