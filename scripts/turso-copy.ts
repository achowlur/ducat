/**
 * Copies a local Ducat database into a fresh cloud one, so a deployment starts
 * with real history instead of whatever the feed can still reach.
 *
 *   DATABASE_URL="libsql://…" TURSO_AUTH_TOKEN="…" npm run turso:copy
 *   DATABASE_URL="libsql://…" TURSO_AUTH_TOKEN="…" npm run turso:copy -- --apply
 *
 * Dry run by default, like repair:text and repair:merchants.
 *
 * DESTINATION is `DATABASE_URL` (matching turso:push and rules:install, so the
 * inline-variable habit carries over); SOURCE is the local file, `--from=` to
 * override. It REFUSES a destination holding any transactions: this is a
 * one-way copy into a fresh instance, not a merge, and there is no sensible way
 * to reconcile two divergent histories of the same accounts.
 *
 * Why it clears the destination first: `rules:install` has already seeded 15
 * categories and 421 pack rules there, and the source carries its own copies of
 * both. Inserting on top would duplicate every category by name and leave two
 * rules for every pattern. With no transactions present there is no user data
 * to lose, which is exactly what the guard above establishes.
 *
 * For the other direction — cloud back to a dated local file — see
 * `npm run cloud:backup`.
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { clearAndCopy, countRows, integrityOf, readPlan, verifyAgainst } from './copyDatabase';

const APPLY = process.argv.includes('--apply');
const FROM = process.argv.find((a) => a.startsWith('--from='))?.slice('--from='.length) ?? 'file:./data/ducat.db';

async function main(): Promise<void> {
  const destUrl = process.env.DATABASE_URL;
  if (destUrl === undefined || destUrl === '') {
    throw new Error('DATABASE_URL (the DESTINATION) is not set.');
  }
  const sourcePath = FROM.replace(/^file:/, '');
  if (destUrl.replace(/^file:/, '') === sourcePath) {
    throw new Error('Source and destination are the same database.');
  }
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (destUrl.startsWith('libsql://') && (authToken === undefined || authToken === '')) {
    throw new Error('TURSO_AUTH_TOKEN is required for a libsql:// destination.');
  }

  // One client for both ends: @libsql/client speaks file: and libsql: alike, and
  // it is a runtime dependency rather than a devDep (better-sqlite3 is the
  // latter, so a script importing it breaks under `npm ci --omit=dev`).
  const src = createClient({ url: FROM, authToken: FROM.startsWith('libsql://') ? authToken : undefined });
  const dest = createClient({ url: destUrl, authToken });
  console.log(`From: ${sourcePath}`);
  console.log(`To:   ${destUrl.startsWith('file:') ? destUrl : new URL(destUrl).host}`);

  try {
    const destTxns = await countRows(dest, 'Transaction');
    if (destTxns > 0) {
      console.error(`\nRefusing to copy: the destination already holds ${destTxns} transactions.`);
      console.error('This is a one-way copy into a fresh instance, not a merge.');
      process.exitCode = 1;
      return;
    }

    // What is about to move, and what is about to be cleared to make room.
    const plan = await readPlan(src);
    console.log('\nTable                 source rows   destination now');
    for (const { table, rows } of plan) {
      const there = await countRows(dest, table);
      console.log(`  ${table.padEnd(20)} ${String(rows.length).padStart(6)}   ${String(there).padStart(6)}${there > 0 ? '  (will be cleared)' : ''}`);
    }

    const checks = await integrityOf(src);
    console.log('\nIntegrity checks to reproduce on the far side:');
    for (const [k, v] of Object.entries(checks)) console.log(`  ${k.padEnd(26)} ${v}`);

    if (!APPLY) {
      console.log('\nDry run. Re-run with `-- --apply` to write.');
      return;
    }

    await clearAndCopy(dest, plan, (l) => console.log(l));
    console.log('\nVerifying against the source:');
    if (!(await verifyAgainst(dest, plan, checks, (l) => console.log(l)))) {
      console.error('\nSomething did not match. Do NOT sync into this database; tell me what failed.');
      process.exitCode = 1;
      return;
    }
    console.log('\nCopy verified. Insights came across, so dismissals are preserved.');
  } finally {
    src.close();
    dest.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
