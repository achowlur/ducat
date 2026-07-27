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
 * The output is an ordinary Ducat database. To inspect one, point the app at it:
 *   DATABASE_URL="file:./data/backups/<file>" npm run dev
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clearAndCopy, integrityOf, readPlan, verifyAgainst, baselineSql } from './copyDatabase';

const DIR = join('data', 'backups');

/** Local time, minute resolution, sortable: ducat-2026-07-26-2145.db */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

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
  const path = join(DIR, `ducat-${stamp()}.db`);
  const cloud = createClient({ url: cloudUrl, authToken });
  const local = createClient({ url: `file:${path.replace(/\\/g, '/')}` });
  console.log(`From: ${new URL(cloudUrl).host}`);
  console.log(`To:   ${path}`);

  try {
    const plan = await readPlan(cloud);
    const total = plan.reduce((s, p) => s + p.rows.length, 0);
    if (total === 0) {
      throw new Error('The cloud database is empty. Refusing to write an empty backup.');
    }
    const checks = await integrityOf(cloud);

    // A brand-new file has no tables; give it the schema before filling it.
    await local.executeMultiple(baselineSql());
    await clearAndCopy(local, plan, (l) => console.log(l));

    console.log('\nVerifying against the cloud:');
    if (!(await verifyAgainst(local, plan, checks, (l) => console.log(l)))) {
      console.error(`\nBackup did NOT verify. Treat ${path} as unusable.`);
      process.exitCode = 1;
      return;
    }
    const kb = Math.round(statSync(path).size / 1024);
    console.log(`\nBacked up ${total} rows to ${path} (${kb} KB).`);
    console.log(`Inspect it with:  DATABASE_URL="file:./${path.replace(/\\/g, '/')}" npm run dev`);
  } finally {
    cloud.close();
    local.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
