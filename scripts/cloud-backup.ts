/**
 * Pulls the cloud database into a dated local SQLite file.
 *
 *   DATABASE_URL="libsql://…" TURSO_AUTH_TOKEN="…" npm run cloud:backup
 *
 * Why this exists even though Turso takes its own backups: on the free plan
 * point-in-time recovery reaches back 24 HOURS (10 days on Developer, 30 on
 * Scaler, 90 on Pro). That window covers "I just deleted the wrong thing" and
 * nothing else — and the failures this app has actually had were silent wrong
 * numbers noticed days later, not visible losses noticed at once. A local file
 * is also a different failure domain: an account problem, a revoked token or a
 * lapsed plan doesn't reach your disk.
 *
 * Writes a NEW file every run, under data/backups/, rather than overwriting
 * anything. `data/` is gitignored, and keeping the dev database out of the way
 * means a stray `db:seed` or migration can't eat the backup.
 *
 * This is the MANUAL, credentials-in-the-shell form. The nightly scheduled
 * form is `backup:scheduled`, which shares this exact copy-and-verify core
 * (`backupToFile` in copyDatabase.ts) and adds fingerprint verification,
 * retention pruning and the `backup.lastRun` Setting. This one deliberately
 * adds none of that: it never deletes a file and never writes a row.
 *
 * The output is an ordinary Ducat database. To inspect one, point the app at it:
 *   DATABASE_URL="file:./data/backups/<file>" npm run dev
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backupToFile, renameWhenReleased } from './copyDatabase';
import { backupFileName } from './retention';

const DIR = join('data', 'backups');

async function main(): Promise<void> {
  const cloudUrl = process.env.DATABASE_URL;
  if (cloudUrl === undefined || cloudUrl === '') {
    throw new Error('DATABASE_URL is not set. Point it at the CLOUD database you want to back up.');
  }
  if (!cloudUrl.startsWith('libsql://')) {
    // Backing a local file up to another local file is a file copy, not this.
    throw new Error(`DATABASE_URL is "${cloudUrl}", not a libsql:// URL. This backs up the CLOUD database.`);
  }
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (authToken === undefined || authToken === '') {
    throw new Error('TURSO_AUTH_TOKEN is required.');
  }

  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, backupFileName(new Date()));
  // Written as .partial and renamed only after verifying, so a failed or
  // interrupted run leaves nothing the scheduled wrapper's retention pass
  // could mistake for a proven backup (only exact ducat-….db names are
  // pruning candidates — see scripts/retention.ts).
  const partial = `${path}.partial`;
  const cloud = createClient({ url: cloudUrl, authToken });
  console.log(`From: ${new URL(cloudUrl).host}`);
  console.log(`To:   ${path}`);

  try {
    const { ok, totalRows } = await backupToFile(cloud, partial, (l) => console.log(l));
    if (!ok) {
      await renameWhenReleased(partial, `${path}.unverified`);
      console.error(`\nBackup did NOT verify. Quarantined as ${path}.unverified — unusable.`);
      process.exitCode = 1;
      return;
    }
    await renameWhenReleased(partial, path);
    const kb = Math.round(statSync(path).size / 1024);
    console.log(`\nBacked up ${totalRows} rows to ${path} (${kb} KB).`);
    console.log(`Inspect it with:  DATABASE_URL="file:./${path.replace(/\\/g, '/')}" npm run dev`);
  } finally {
    cloud.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
