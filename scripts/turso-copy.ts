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
 * Self-referential columns (Transaction.transferPairId, Transaction.reimbursesId,
 * Category.parentId) are written in a SECOND pass. Inserting them inline would
 * depend on row order, and the obvious escape — turning foreign keys off with a
 * pragma — is not reliably available on Turso Cloud.
 */
import 'dotenv/config';
import { createClient, type Client, type InStatement } from '@libsql/client';

const APPLY = process.argv.includes('--apply');
const FROM = process.argv.find((a) => a.startsWith('--from='))?.slice('--from='.length) ?? 'file:./data/ducat.db';

/** Parents before children. Within a table, self-references are deferred. */
const TABLES = [
  'Account',
  'Category',
  'Setting',
  'SyncLog',
  'TrackedSubscription',
  'Insight',
  'Rule',
  'BalanceSnapshot',
  'Transaction',
] as const;

/** Columns written only after every row of their own table exists. */
const DEFERRED: Partial<Record<(typeof TABLES)[number], string[]>> = {
  Category: ['parentId'],
  Transaction: ['transferPairId', 'reimbursesId'],
};

const q = (id: string) => `"${id}"`;
const CHUNK = 50;

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

  // One client for both ends: @libsql/client speaks file: and libsql: alike, it
  // is a runtime dependency rather than a devDep (better-sqlite3 is the latter,
  // so a script importing it breaks under `npm ci --omit=dev`), and asking a
  // result for its own `columns` avoids PRAGMA, which Turso Cloud restricts.
  const src = createClient({ url: FROM });
  const dest = createClient({ url: destUrl, authToken });
  console.log(`From: ${sourcePath}`);
  console.log(`To:   ${destUrl.startsWith('file:') ? destUrl : new URL(destUrl).host}`);

  try {
    const destTxns = Number((await dest.execute('select count(*) as c from "Transaction"')).rows[0].c);
    if (destTxns > 0) {
      console.error(`\nRefusing to copy: the destination already holds ${destTxns} transactions.`);
      console.error('This is a one-way copy into a fresh instance, not a merge.');
      process.exitCode = 1;
      return;
    }

    // What is about to move, and what is about to be cleared to make room.
    const plan: { table: (typeof TABLES)[number]; columns: string[]; rows: Record<string, unknown>[] }[] = [];
    for (const table of TABLES) {
      const result = await src.execute(`select * from ${q(table)}`);
      plan.push({ table, columns: [...result.columns], rows: result.rows as unknown as Record<string, unknown>[] });
    }
    console.log('\nTable                 source rows   destination now');
    for (const { table, rows } of plan) {
      const there = Number((await dest.execute(`select count(*) as c from ${q(table)}`)).rows[0].c);
      console.log(`  ${table.padEnd(20)} ${String(rows.length).padStart(6)}   ${String(there).padStart(6)}${there > 0 ? '  (will be cleared)' : ''}`);
    }

    const checks = await integrityOf(src);
    console.log('\nIntegrity checks to reproduce on the far side:');
    for (const [k, v] of Object.entries(checks)) console.log(`  ${k.padEnd(26)} ${v}`);

    if (!APPLY) {
      console.log('\nDry run. Re-run with `-- --apply` to write.');
      return;
    }

    // Clear in reverse dependency order, then fill forwards.
    for (const { table } of [...plan].reverse()) await dest.execute(`delete from ${q(table)}`);

    for (const { table, columns, rows } of plan) {
      if (rows.length === 0) continue;
      const deferred = DEFERRED[table] ?? [];
      const insertCols = columns.filter((c) => !deferred.includes(c));
      const sql = `insert into ${q(table)} (${insertCols.map(q).join(', ')}) values (${insertCols.map(() => '?').join(', ')})`;
      const stmts: InStatement[] = rows.map((r) => ({ sql, args: insertCols.map((c) => r[c] as never) }));
      for (let i = 0; i < stmts.length; i += CHUNK) await dest.batch(stmts.slice(i, i + CHUNK), 'write');

      // Second pass: the self-references, now that every target row exists.
      const fixes: InStatement[] = [];
      for (const r of rows) {
        const set = deferred.filter((c) => r[c] !== null && r[c] !== undefined);
        if (set.length === 0) continue;
        fixes.push({
          sql: `update ${q(table)} set ${set.map((c) => `${q(c)} = ?`).join(', ')} where "id" = ?`,
          args: [...set.map((c) => r[c] as never), r.id as never],
        });
      }
      for (let i = 0; i < fixes.length; i += CHUNK) await dest.batch(fixes.slice(i, i + CHUNK), 'write');
      console.log(`  ${table.padEnd(20)} ${rows.length} rows${fixes.length > 0 ? `, ${fixes.length} self-references` : ''}`);
    }

    console.log('\nVerifying against the source:');
    let mismatch = false;
    for (const { table, rows } of plan) {
      const there = Number((await dest.execute(`select count(*) as c from ${q(table)}`)).rows[0].c);
      const ok = there === rows.length;
      if (!ok) mismatch = true;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${table.padEnd(20)} ${rows.length} -> ${there}`);
    }
    const after = await integrityOf(dest);
    for (const [k, v] of Object.entries(checks)) {
      const ok = String(after[k]) === String(v);
      if (!ok) mismatch = true;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${k.padEnd(20)} ${v} -> ${after[k]}`);
    }
    if (mismatch) {
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

/** Same aggregates, run on either end — the comparison is the point. */
async function integrityOf(db: Client): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, sql] of Object.entries(CHECK_SQL)) out[k] = (await db.execute(sql)).rows[0].v;
  return out;
}

/** Aggregates that would notice a dropped, duplicated or mangled row. */
const CHECK_SQL: Record<string, string> = {
  transactions: 'select count(*) as v from "Transaction"',
  'sum(amount)': 'select round(sum(amount), 2) as v from "Transaction"',
  'net worth': 'select round(sum(balance), 2) as v from "Account"',
  MANUAL: `select count(*) as v from "Transaction" where categorySource = 'MANUAL'`,
  TRANSFER: `select count(*) as v from "Transaction" where flow = 'TRANSFER'`,
  'transfer pairs': 'select count(*) as v from "Transaction" where transferPairId is not null',
  reimbursements: 'select count(*) as v from "Transaction" where reimbursesId is not null',
  'enabled rules': 'select count(*) as v from "Rule" where enabled = 1',
};

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
