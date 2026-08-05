/**
 * A content FINGERPRINT of any Ducat database, for comparing two of them.
 *
 * `cloud:backup` already verifies its own output — per-table row counts plus
 * the eight aggregates in `CHECK_SQL`. That answers "did the copy land", and
 * it is not the same question as "is every row identical". A table can hold
 * the right number of rows summing to the right total and still differ: a
 * changed category on one transaction, a flipped `dismissed`, a renamed group
 * label, an edited rule. Counts and sums are blind to all of it.
 *
 * So this hashes CONTENT — the core lives in `fingerprintDatabase.ts`, shared
 * with the scheduled backup wrapper, which runs the same comparison
 * unattended. Every row of every table is serialised deterministically, the
 * serialised rows are sorted (so physical order and rowid assignment cannot
 * matter), and the result is one SHA-256 per table. Two databases whose
 * per-table digests all match are identical in every column of every row.
 *
 * Runs against `file:` and `libsql:` URLs through the SAME client, which is
 * the point — comparing values that took different paths out of the database
 * would compare the paths, not the data.
 *
 * KNOWN LIMIT: each table is read whole into memory to be sorted and hashed.
 * Fine at this scale (2,745 transactions, 631 rules) and fine for years of
 * accumulation; it would need chunking with a merge-sort at millions of rows.
 * Read-only — it opens a client and issues SELECTs, so it is safe to point at
 * either database, and it prints the label first like every row-writing script
 * so a shell still holding cloud variables cannot mislead you.
 *
 *   npx tsx scripts/fingerprint-db.ts
 *   DATABASE_URL="libsql://…" TURSO_AUTH_TOKEN="…" npx tsx scripts/fingerprint-db.ts
 *   DATABASE_URL="file:./data/backups/ducat-2026-08-04-1854.db" npx tsx scripts/fingerprint-db.ts
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { CHECK_SQL, TABLES } from './copyDatabase';
import { databaseLabel } from './database-label';
import { fingerprintOf } from './fingerprintDatabase';

/** Extra aggregates beyond CHECK_SQL — the fields hand-editing actually touches. */
const EXTRA_SQL: Record<string, string> = {
  'txn date range': `select coalesce(min(date), '-') || ' .. ' || coalesce(max(date), '-') as v from "Transaction"`,
  'categorised txns': 'select count(*) as v from "Transaction" where categoryId is not null',
  'tagged (groupLabel)': 'select count(*) as v from "Transaction" where groupLabel is not null',
  'distinct groups': 'select count(distinct groupLabel) as v from "Transaction" where groupLabel is not null',
  'insights dismissed': 'select count(*) as v from "Insight" where dismissed = 1',
  'insight periods': 'select count(distinct period) as v from "Insight"',
  'snapshots': 'select count(*) as v from "BalanceSnapshot"',
  'snapshot latest': `select coalesce(max(date), '-') as v from "BalanceSnapshot"`,
  'accounts stale': 'select count(*) as v from "Account" where isStale = 1',
  'tracked subs': 'select count(*) as v from "TrackedSubscription"',
  'settings': 'select count(*) as v from "Setting"',
  'sync logs': 'select count(*) as v from "SyncLog"',
  'rules total': 'select count(*) as v from "Rule"',
  'categories': 'select count(*) as v from "Category"',
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'file:./data/ducat.db';
  const authToken = process.env.TURSO_AUTH_TOKEN;
  console.log(`\nDatabase: ${databaseLabel(url)}\n`);

  const db = createClient(url.startsWith('libsql://') ? { url, authToken } : { url });

  console.log('Per-table content digest (sha256 of every row, order-independent)');
  const fp = await fingerprintOf(db);
  for (const table of TABLES) {
    const t = fp.tables[table];
    console.log(`  ${table.padEnd(20)} ${String(t.rows).padStart(6)} rows  ${t.digest}`);
  }

  // One digest over the per-table digests: a single value to compare by eye.
  console.log(`  ${'WHOLE DATABASE'.padEnd(20)} ${' '.repeat(11)} ${fp.overall}`);

  console.log('\nAggregates (the eight cloud:backup already checks)');
  for (const [k, sql] of Object.entries(CHECK_SQL)) {
    console.log(`  ${k.padEnd(22)} ${String((await db.execute(sql)).rows[0].v)}`);
  }

  console.log('\nAggregates (hand-edited fields, which counts and sums are blind to)');
  for (const [k, sql] of Object.entries(EXTRA_SQL)) {
    console.log(`  ${k.padEnd(22)} ${String((await db.execute(sql)).rows[0].v)}`);
  }

  console.log('');
}

void main();
