/**
 * Whole-database copy between any two Ducat databases, in either direction.
 *
 * Shared by `turso:copy` (local -> a fresh cloud instance) and `cloud:backup`
 * (cloud -> a dated local file). One implementation, because the hard parts —
 * insert order, deferred self-references, and the integrity comparison — are
 * identical whichever way the data is moving, and a second copy of them would
 * be a second place for the transfer-pair handling to rot.
 */
import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createClient, type Client, type InStatement, type Transaction } from '@libsql/client';

/**
 * Rename that outwaits a lingering file lock. On Windows the libSQL client's
 * close() releases its SQLite handle ASYNCHRONOUSLY, so a rename issued right
 * after close() races it and loses — measured EBUSY on the first live
 * scheduled-backup run, immediately after the fingerprints had matched.
 * Antivirus scanners briefly lock fresh .db files the same way. The release
 * measured 7.75s on a real run (255ms in isolation — the gap is the price of
 * the preceding whole-database read), so the bound is ~30 seconds: wildly
 * more than observed, still finite, and the wait is logged when it happens.
 */
export async function renameWhenReleased(
  from: string,
  to: string,
  log?: (line: string) => void,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      if (attempt > 1) log?.(`  (rename waited ${(attempt - 1) * 250}ms for the file handle to release)`);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt >= 120) throw e;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Parents before children. Within a table, self-references are deferred. */
export const TABLES = [
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

export type TableName = (typeof TABLES)[number];

/**
 * Columns written only after every row of their own table exists. Inserting
 * them inline would depend on row order, and the obvious escape — turning
 * foreign keys off with a pragma — is restricted on Turso Cloud.
 */
export const DEFERRED: Partial<Record<TableName, string[]>> = {
  Category: ['parentId'],
  Transaction: ['transferPairId', 'reimbursesId'],
};

/** Aggregates that would notice a dropped, duplicated or mangled row. */
export const CHECK_SQL: Record<string, string> = {
  transactions: 'select count(*) as v from "Transaction"',
  'sum(amount)': 'select round(sum(amount), 2) as v from "Transaction"',
  'net worth': 'select round(sum(balance), 2) as v from "Account"',
  MANUAL: `select count(*) as v from "Transaction" where categorySource = 'MANUAL'`,
  TRANSFER: `select count(*) as v from "Transaction" where flow = 'TRANSFER'`,
  'transfer pairs': 'select count(*) as v from "Transaction" where transferPairId is not null',
  reimbursements: 'select count(*) as v from "Transaction" where reimbursesId is not null',
  'enabled rules': 'select count(*) as v from "Rule" where enabled = 1',
};

export interface TablePlan {
  table: TableName;
  columns: string[];
  rows: Record<string, unknown>[];
}

const q = (id: string) => `"${id}"`;
const CHUNK = 50;

/**
 * The schema as one SQL script, derived from schema.prisma rather than replayed
 * from prisma/migrations, so it is current by construction.
 *
 * Runs Prisma's JS entrypoint under this same node, not `.bin/prisma`: since the
 * CVE-2024-27980 mitigation, Node refuses to spawn a Windows `.cmd` shim without
 * `shell: true`, and passing arguments through a shell is the worse trade.
 */
export function baselineSql(): string {
  const entry = createRequire(import.meta.url).resolve('prisma/build/index.js');
  return execFileSync(
    process.execPath,
    [entry, 'migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
}

/** Every row of every table, with the column names the source reports. */
export async function readPlan(src: Client): Promise<TablePlan[]> {
  const plan: TablePlan[] = [];
  for (const table of TABLES) {
    const result = await src.execute(`select * from ${q(table)}`);
    plan.push({ table, columns: [...result.columns], rows: result.rows as unknown as Record<string, unknown>[] });
  }
  return plan;
}

export async function integrityOf(db: Client): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, sql] of Object.entries(CHECK_SQL)) out[k] = (await db.execute(sql)).rows[0].v;
  return out;
}

export async function countRows(db: Client, table: TableName): Promise<number> {
  return Number((await db.execute(`select count(*) as c from ${q(table)}`)).rows[0].c);
}

/**
 * Clears the destination in reverse dependency order, then fills it forwards.
 *
 * Accepts an open TRANSACTION as well as a client. Against a client every
 * batch commits on its own, which suits copying into a brand-new file; the
 * local mirror (mirrorLocal.ts) passes a transaction instead, so a failure
 * part-way rolls back to the database it started with rather than leaving
 * one half-cleared.
 */
export async function clearAndCopy(
  dest: Client | Transaction,
  plan: TablePlan[],
  log: (line: string) => void,
): Promise<void> {
  const runBatch = (stmts: InStatement[]) =>
    'commit' in dest ? dest.batch(stmts) : dest.batch(stmts, 'write');
  for (const { table } of [...plan].reverse()) await dest.execute(`delete from ${q(table)}`);

  for (const { table, columns, rows } of plan) {
    if (rows.length === 0) continue;
    const deferred = DEFERRED[table] ?? [];
    const insertCols = columns.filter((c) => !deferred.includes(c));
    const sql = `insert into ${q(table)} (${insertCols.map(q).join(', ')}) values (${insertCols.map(() => '?').join(', ')})`;
    const stmts: InStatement[] = rows.map((r) => ({ sql, args: insertCols.map((c) => r[c] as never) }));
    for (let i = 0; i < stmts.length; i += CHUNK) await runBatch(stmts.slice(i, i + CHUNK));

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
    for (let i = 0; i < fixes.length; i += CHUNK) await runBatch(fixes.slice(i, i + CHUNK));
    log(`  ${table.padEnd(20)} ${rows.length} rows${fixes.length > 0 ? `, ${fixes.length} self-references` : ''}`);
  }
}

/**
 * The whole `cloud:backup` core — source database to a verified file — shared
 * with the scheduled wrapper so there is exactly one implementation of "write
 * a backup that has been checked against its source". The file gets the
 * schema first (a brand-new file has no tables), then every row, then the
 * count/aggregate verification. Content fingerprints are the CALLER's second
 * check, deliberately separate: this function proves the copy landed, the
 * fingerprint proves every row is identical.
 */
export async function backupToFile(
  src: Client,
  filePath: string,
  log: (line: string) => void,
): Promise<{ ok: boolean; totalRows: number }> {
  const dest = createClient({ url: `file:${filePath.replace(/\\/g, '/')}` });
  try {
    const plan = await readPlan(src);
    const totalRows = plan.reduce((s, p) => s + p.rows.length, 0);
    if (totalRows === 0) {
      throw new Error('The source database is empty. Refusing to write an empty backup.');
    }
    const checks = await integrityOf(src);
    await dest.executeMultiple(baselineSql());
    await clearAndCopy(dest, plan, log);
    log('\nVerifying against the source:');
    const ok = await verifyAgainst(dest, plan, checks, log);
    return { ok, totalRows };
  } finally {
    dest.close();
  }
}

/** True only if every row count and every aggregate matches the source. */
export async function verifyAgainst(
  dest: Client,
  plan: TablePlan[],
  checks: Record<string, unknown>,
  log: (line: string) => void,
): Promise<boolean> {
  let ok = true;
  for (const { table, rows } of plan) {
    const there = await countRows(dest, table);
    const match = there === rows.length;
    if (!match) ok = false;
    log(`  ${match ? 'ok  ' : 'FAIL'} ${table.padEnd(20)} ${rows.length} -> ${there}`);
  }
  const after = await integrityOf(dest);
  for (const [k, v] of Object.entries(checks)) {
    const match = String(after[k]) === String(v);
    if (!match) ok = false;
    log(`  ${match ? 'ok  ' : 'FAIL'} ${k.padEnd(20)} ${v} -> ${after[k]}`);
  }
  return ok;
}
