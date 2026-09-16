/**
 * `npm run db:mirror` — make the local database a copy of a verified backup,
 * on demand. The nightly `backup:scheduled` does this by itself after every
 * backup; this is for starting it the first time, and for any moment local
 * must be current before tonight.
 *
 * Without --confirm it only REPORTS: which backup, both whole-database digests,
 * and whether local has changed since it was last mirrored — which is the one
 * case where replacing it would lose work. With --confirm it keeps the current
 * local file as data/ducat-superseded-YYYY-MM-DD-HHMM.db (never deleted by
 * anything), copies the backup's rows in one transaction, proves the result
 * matches the backup, and records local's new state so the nightly job can
 * carry on from here.
 *
 * Mirrors from a backup FILE only — the newest canonical one by default, never
 * a `.partial` or `.unverified` — so it needs no credentials and no network.
 *
 *   npm run db:mirror
 *   npm run db:mirror -- --confirm
 *   npm run db:mirror -- --from=data/backups/ducat-YYYY-MM-DD-HHMM.db --confirm
 */
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createClient } from '@libsql/client';
import { arg, hasFlag } from './args';
import { databaseLabel } from './database-label';
import { fingerprintOf } from './fingerprintDatabase';
import {
  LOCAL_DB_PATH,
  MIRROR_STATE_PATH,
  mirrorIntoLocal,
  readMirrorState,
  recordMirrorState,
  tablesChangedSince,
} from './mirrorLocal';
import { BACKUP_FILE, backupFileName } from './retention';

const DIR = join('data', 'backups');
const fileUrl = (path: string) => `file:${path.replace(/\\/g, '/')}`;

function newestBackup(): string | null {
  if (!existsSync(DIR)) return null;
  // Canonical names sort chronologically, which is why they are canonical.
  const names = readdirSync(DIR).filter((n) => BACKUP_FILE.test(n)).sort();
  return names.length === 0 ? null : join(DIR, names[names.length - 1]);
}

async function main(): Promise<void> {
  console.log(`\nDatabase: ${databaseLabel(fileUrl(`./${LOCAL_DB_PATH}`))}`);
  const confirm = hasFlag('confirm');
  const sourcePath = arg('from') ?? newestBackup();
  if (sourcePath === null) {
    throw new Error(`No verified backup in ${DIR}. The nightly backup:scheduled writes one.`);
  }
  if (!existsSync(LOCAL_DB_PATH)) {
    throw new Error(`${LOCAL_DB_PATH} does not exist — there is no local database to update.`);
  }
  console.log(`Source:   ${sourcePath}\n`);

  const src = createClient({ url: fileUrl(sourcePath) });
  const local = createClient({ url: fileUrl(LOCAL_DB_PATH) });
  let sourceWhole: string;
  let localFp;
  try {
    sourceWhole = (await fingerprintOf(src)).overall;
    localFp = await fingerprintOf(local);
  } finally {
    src.close();
    local.close();
  }
  console.log(`  backup  WHOLE DATABASE ${sourceWhole}  (${basename(sourcePath)})`);
  console.log(`  local   WHOLE DATABASE ${localFp.overall}  (${LOCAL_DB_PATH})`);

  const state = readMirrorState(MIRROR_STATE_PATH);
  if (state === null) {
    console.log('\nLocal has never been mirrored, so nothing proves it holds no work of its own.');
  } else {
    const changed = tablesChangedSince(localFp, state);
    console.log(
      changed.length === 0
        ? `\nLocal is unchanged since it was mirrored from ${state.source} at ${state.at}.`
        : `\nLocal HAS CHANGED since it was mirrored from ${state.source} at ${state.at}: ${changed.join(', ')}. ` +
            'Replacing it loses that work unless it was also done on the cloud.',
    );
  }

  if (sourceWhole === localFp.overall) {
    console.log('\nLocal already matches this backup exactly.');
    if (confirm) {
      recordMirrorState(localFp, basename(sourcePath), MIRROR_STATE_PATH);
      console.log(`Recorded as a mirror in ${MIRROR_STATE_PATH}; the nightly job carries on from here.`);
    }
    return;
  }
  if (!confirm) {
    console.log(
      '\nNothing written. Re-run with `-- --confirm` to replace local with this backup; the current local file ' +
        'is kept as data/ducat-superseded-<date>.db first.',
    );
    return;
  }

  const kept = join('data', backupFileName(new Date()).replace(/^ducat-/, 'ducat-superseded-'));
  if (existsSync(kept)) throw new Error(`${kept} already exists — wait a minute and re-run, so nothing is overwritten.`);
  const snapshot = createClient({ url: fileUrl(LOCAL_DB_PATH) });
  try {
    // VACUUM INTO writes a consistent copy even while the dev server has the
    // database open, which a plain file copy cannot promise.
    await snapshot.execute({ sql: 'VACUUM INTO ?', args: [kept.replace(/\\/g, '/')] });
  } finally {
    snapshot.close();
  }
  console.log(`\nKept the current local database as ${kept}`);

  const outcome = await mirrorIntoLocal({
    sourcePath,
    localPath: LOCAL_DB_PATH,
    unchangedSince: 'confirmed',
    log: (line) => console.log(line),
  });
  if (outcome.status !== 'mirrored') {
    const detail = outcome.status === 'ready' ? 'unexpected dry-run result' : outcome.detail;
    throw new Error(`Local was NOT changed: ${detail}. ${kept} is an extra copy and can be deleted.`);
  }
  recordMirrorState(outcome.after, outcome.source, MIRROR_STATE_PATH);
  console.log(
    `\nDone: local ${outcome.before.overall} -> ${outcome.after.overall}, which is ${basename(sourcePath)} exactly. ` +
      `Recorded in ${MIRROR_STATE_PATH}; the nightly backup keeps local current from now on.`,
  );
}

main().catch((e: unknown) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
