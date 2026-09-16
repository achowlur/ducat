/**
 * The nightly scheduled backup: cloud → a dated, content-verified file on
 * this machine, plus the `backup.lastRun` Setting that lets /providers say
 * when that last happened. Fired by the Windows Task Scheduler at 23:50 UTC —
 * AFTER the `0 23 * * *` sync cron plus Vercel Hobby's documented 8-43
 * minutes of lateness, because backing up before the sync permanently
 * captures yesterday. Runs headless and appends everything it prints to
 * data/backups/backup.log, so a run nobody watched is still readable.
 * Manual run:  npm run backup:scheduled  (add -- --dry-run to see what the
 * pruning and Setting steps WOULD do without doing them).
 *
 * CREDENTIALS come from `.env.backup` (gitignored) and NOWHERE else — never
 * `.env`, which points at the local database, and never the shell, so a
 * terminal still holding cloud variables cannot redirect this script and the
 * scheduler's empty environment still works. The file holds exactly two
 * lines: DATABASE_URL="libsql://…" and TURSO_AUTH_TOKEN="…".
 *
 * Order matters and each step gates the next:
 *   1. copy onto a `.partial` name + count/aggregate verification — the
 *      shared `cloud:backup` core. Only verification ever renames the file
 *      to its canonical `ducat-….db` name, so a hard crash leaves nothing
 *      retention could mistake for a proven backup;
 *   2. content fingerprints of the CLOUD and the FILE, compared whole.
 *      Counts are blind to a changed category or a flipped `dismissed`; the
 *      digest is the proof the mirror rule requires. A mismatch usually
 *      means a write landed mid-copy — the run fails and the file is
 *      QUARANTINED as `.unverified`: inspectable forever, invisible to
 *      retention, which otherwise would one day elect it a month's sole
 *      keeper and delete the proven backups around it;
 *   3. retention pruning (~14 daily dates, newest-per-month beyond) — only
 *      after a verified new backup, so a failing job never eats history;
 *   4. the LOCAL MIRROR: data/ducat.db becomes a copy of the verified file,
 *      in one transaction, and only if nothing has written to local since it
 *      was last mirrored (scripts/mirrorLocal.ts). A refusal or a rolled-back
 *      failure leaves local completely untouched — local is written by
 *      exactly one thing, a successful mirror — and is reported in the
 *      Setting, so the phone sees it;
 *   5. the Setting, carrying the mirror's outcome, written to the CLOUD first
 *      and then — only after a successful mirror — byte-identically to local,
 *      whose new state is then recorded for tomorrow's check. A failed run
 *      writes NO Setting — /providers' age measures days since the last
 *      PROVEN copy.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createClient } from '@libsql/client';
import { parse } from 'dotenv';
import { BACKUP_SETTING_KEY, type StoredBackupRun } from '../src/lib/health/backup';
import { backupToFile, renameWhenReleased } from './copyDatabase';
import { databaseLabel } from './database-label';
import { fingerprintOf, type DatabaseFingerprint } from './fingerprintDatabase';
import { LOCAL_DB_PATH, MIRROR_STATE_PATH, mirrorIntoLocal, readMirrorState, recordMirrorState } from './mirrorLocal';
import { backupFileName, planRetention } from './retention';
import { hasFlag } from './args';

const DIR = join('data', 'backups');
const LOG_PATH = join(DIR, 'backup.log');
const CRED_FILE = '.env.backup';
const LOCAL_URL = `file:./${LOCAL_DB_PATH.replace(/\\/g, '/')}`;

/** Console AND backup.log, line by line, so a crash still leaves a trail. */
function makeLog(): (line: string) => void {
  return (line: string) => {
    console.log(line);
    appendFileSync(LOG_PATH, `${line}\n`);
  };
}

/**
 * The two Turso variables, read from the gitignored file EXCLUSIVELY.
 * process.env is deliberately not consulted: this script must behave
 * identically from a hand shell and from the scheduler's bare session.
 */
function readCredentials(): { url: string; authToken: string } {
  if (!existsSync(CRED_FILE)) {
    throw new Error(
      `${CRED_FILE} not found. Create it (it is gitignored) with exactly two lines:\n` +
        `  DATABASE_URL="libsql://<db>-<org>.<region>.turso.io"\n` +
        `  TURSO_AUTH_TOKEN="<database token>"\n` +
        `See DEPLOY.md, "Scheduled local backups".`,
    );
  }
  const parsed = parse(readFileSync(CRED_FILE, 'utf8'));
  const url = parsed.DATABASE_URL ?? '';
  const authToken = parsed.TURSO_AUTH_TOKEN ?? '';
  if (!url.startsWith('libsql://')) {
    // Deliberately does NOT echo the value: a paste mistake could put the
    // auth token in this slot, and this message lands in backup.log.
    const what = url === '' ? 'nothing' : url.startsWith('file:') ? 'a file: URL' : 'a non-libsql value (not shown)';
    throw new Error(`${CRED_FILE} must set DATABASE_URL to a libsql:// URL (found ${what}). This backs up the CLOUD database.`);
  }
  if (authToken === '') {
    throw new Error(`${CRED_FILE} must set TURSO_AUTH_TOKEN.`);
  }
  return { url, authToken };
}

const upsertSettingSql =
  `insert into "Setting" ("key", "value") values (?, ?) ` +
  `on conflict("key") do update set "value" = excluded."value"`;

/**
 * A file that failed verification must never wear the name retention treats
 * as a proven backup: the review's confirmed failure mode was a mismatch
 * leftover quietly becoming a month's SOLE keeper weeks later, evicting
 * every proven backup of that month. `.unverified` is outside BACKUP_FILE,
 * so retention ignores it by construction — inspectable forever, competing
 * never. (The copy itself lands on a `.partial` name for the same reason: a
 * hard crash mid-copy leaves nothing bearing the verified name either.)
 */
async function quarantine(partialPath: string, finalPath: string, log: (l: string) => void): Promise<string> {
  const target = `${finalPath}.unverified`;
  await renameWhenReleased(partialPath, target);
  log(`  quarantined as ${basename(target)} — retention ignores it; inspect or delete it by hand`);
  return target;
}

function digestTable(fp: DatabaseFingerprint, label: string, log: (l: string) => void): void {
  for (const [table, t] of Object.entries(fp.tables)) {
    log(`    ${table.padEnd(20)} ${String(t.rows).padStart(6)} rows  ${t.digest}`);
  }
  log(`    ${'WHOLE DATABASE'.padEnd(20)} ${' '.repeat(11)} ${fp.overall}  (${label})`);
}

async function main(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const log = makeLog();
  const dryRun = hasFlag('dry-run');
  const started = new Date();
  log(`\n=== scheduled backup ${started.toISOString()}${dryRun ? ' (DRY RUN)' : ''} ===`);

  const { url, authToken } = readCredentials();
  const path = join(DIR, backupFileName(started));
  // The copy lands on a name retention ignores; only VERIFICATION renames it
  // to the canonical one. The invariant this buys: a file named
  // ducat-YYYY-MM-DD-HHMM.db is always a backup that passed its checks.
  const partial = `${path}.partial`;
  log(`Source: ${databaseLabel(url)}`);
  log(`Dest:   ${path} (via .partial until verified)`);

  const cloud = createClient({ url, authToken });
  try {
    // 1. Copy + the count/aggregate verification cloud:backup has always done.
    const { ok, totalRows } = await backupToFile(cloud, partial, log);
    if (!ok) {
      await quarantine(partial, path, log);
      throw new Error(`count/aggregate verification FAILED — quarantined as ${basename(path)}.unverified.`);
    }

    // 2. Content fingerprints, both sides. The order-independent digest makes
    //    the two reads comparable even though rows travelled in between.
    //    The file client closes before any rename: Windows refuses to rename
    //    an open file.
    log('\nContent fingerprints (cloud vs the file just written):');
    const cloudFp = await fingerprintOf(cloud);
    const file = createClient({ url: `file:${partial.replace(/\\/g, '/')}` });
    let fileFp;
    try {
      fileFp = await fingerprintOf(file);
    } finally {
      file.close();
    }
    if (cloudFp.overall !== fileFp.overall) {
      const differing = Object.keys(cloudFp.tables).filter(
        (t) => cloudFp.tables[t].digest !== fileFp.tables[t].digest,
      );
      log('  MISMATCH — per-table digests, both sides:');
      digestTable(cloudFp, 'cloud', log);
      digestTable(fileFp, 'file', log);
      await quarantine(partial, path, log);
      throw new Error(
        `content fingerprints differ (${differing.join(', ')}). A write likely landed mid-copy — ` +
          `the file is quarantined for inspection, NOT a proven backup, and no Setting is written.`,
      );
    }
    await renameWhenReleased(partial, path, log);
    log(`  match: WHOLE DATABASE ${fileFp.overall} on both sides — ${basename(path)} now bears its verified name`);

    // 3. Retention — only now, with a proven new backup in hand.
    const plan = planRetention(readdirSync(DIR));
    log(`\nRetention: keeping ${plan.keep.length} (${plan.ignored.length} non-backup files untouched)`);
    for (const name of plan.remove) {
      if (dryRun) {
        log(`  would remove ${name}`);
      } else {
        unlinkSync(join(DIR, name));
        log(`  removed ${name}`);
      }
    }
    if (plan.remove.length === 0) log('  nothing to remove');

    // 4. The local mirror — from the file just proved equal to the cloud.
    log(`\nLocal mirror: ${databaseLabel(LOCAL_URL)} <- ${basename(path)}`);
    const mirror = await mirrorIntoLocal({
      sourcePath: path,
      localPath: LOCAL_DB_PATH,
      unchangedSince: readMirrorState(MIRROR_STATE_PATH),
      dryRun,
      log,
    });
    if (mirror.status === 'mirrored') {
      // Recorded at once: if the Setting writes below fail, tomorrow's check
      // still compares against the local this run actually left behind.
      recordMirrorState(mirror.after, mirror.source, MIRROR_STATE_PATH);
      log(`  mirrored${mirror.changed ? '' : ' (already current)'}`);
    } else if (mirror.status === 'ready') {
      log('  checks pass — a real run would mirror');
    } else {
      log(`  LOCAL NOT UPDATED (${mirror.status}): ${mirror.detail}`);
    }

    // 5. The Setting — cloud first, then local only if local is now a mirror.
    const run: StoredBackupRun = {
      at: new Date().toISOString(),
      file: basename(path),
      wholeDigest: fileFp.overall,
      rows: totalRows,
      ...(mirror.status === 'mirrored' || mirror.status === 'refused' || mirror.status === 'failed'
        ? { localMirror: { status: mirror.status, detail: mirror.status === 'mirrored' ? null : mirror.detail } }
        : {}),
    };
    const value = JSON.stringify(run);
    log(`\nSetting ${BACKUP_SETTING_KEY} = ${value}`);
    if (dryRun) {
      log(`  would write to ${databaseLabel(url)}${mirror.status === 'ready' ? ` then ${databaseLabel(LOCAL_URL)}` : ''}`);
    } else {
      await cloud.execute({ sql: upsertSettingSql, args: [BACKUP_SETTING_KEY, value] });
      log(`  written to ${databaseLabel(url)}`);
      if (mirror.status === 'mirrored') {
        const local = createClient({ url: LOCAL_URL });
        try {
          await local.execute({ sql: upsertSettingSql, args: [BACKUP_SETTING_KEY, value] });
          recordMirrorState(await fingerprintOf(local), mirror.source, MIRROR_STATE_PATH);
          log(`  written to ${databaseLabel(LOCAL_URL)} (same value), and local's new state recorded`);
        } catch (e) {
          // The cloud row — the one /providers on the phone reads — is in, and
          // local is a verified mirror one Setting row behind; the state
          // recorded after the mirror still matches it, so tomorrow proceeds.
          log(`  WARNING: local Setting write failed (${e instanceof Error ? e.message : String(e)}) — local is one Setting row behind until the next run.`);
        } finally {
          local.close();
        }
      } else {
        log('  not written to local: local is not a current mirror (see above), and is left exactly as it was');
      }
    }

    const kb = Math.round(statSync(path).size / 1024);
    const secs = ((Date.now() - started.getTime()) / 1000).toFixed(1);
    const localNote =
      mirror.status === 'mirrored' ? 'local mirrored' : mirror.status === 'ready' ? 'local would be mirrored' : `LOCAL NOT UPDATED: ${mirror.detail}`;
    log(`\nOK: ${totalRows} rows → ${basename(path)} (${kb} KB, digest ${fileFp.overall}) in ${secs}s; ${localNote}`);
  } finally {
    cloud.close();
  }
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  try {
    appendFileSync(LOG_PATH, `FAILED: ${message}\n`);
  } catch {
    // the console line below still says it
  }
  console.error(`FAILED: ${message}`);
  process.exitCode = 1;
});
