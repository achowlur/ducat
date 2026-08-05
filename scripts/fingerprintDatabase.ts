/**
 * The content-fingerprint core, shared by `db:fingerprint` (which prints one
 * database for a human to compare) and `backup:scheduled` (which compares the
 * cloud against the file it just wrote, unattended). One implementation,
 * because two hashers that "should" agree is exactly the kind of drift the
 * fingerprint exists to catch in databases.
 *
 * Every row of every table is serialised deterministically, the serialised
 * rows are sorted (so physical order and rowid assignment cannot matter), and
 * the result is one SHA-256 per table plus one digest over the per-table
 * digests. Two databases whose `overall` values match are identical in every
 * column of every row. Read-only: it opens no transaction and issues SELECTs.
 */
import { createHash } from 'node:crypto';
import type { Client } from '@libsql/client';
import { TABLES } from './copyDatabase';

/**
 * Deterministic across clients and URL schemes. Keys are sorted so column
 * order in the result set cannot change the digest; bigint and binary are
 * tagged rather than coerced, so a 1 and a "1" can never hash alike.
 */
function canonical(row: Record<string, unknown>): string {
  const keys = Object.keys(row).sort();
  const parts = keys.map((k) => {
    const v = row[k];
    if (v === null || v === undefined) return `${k}:null`;
    if (typeof v === 'bigint') return `${k}:n(${v.toString()})`;
    if (typeof v === 'number') return `${k}:n(${Number.isInteger(v) ? v.toFixed(0) : v.toString()})`;
    if (v instanceof Uint8Array) return `${k}:b(${Buffer.from(v).toString('hex')})`;
    if (v instanceof Date) return `${k}:d(${v.toISOString()})`;
    return `${k}:s(${String(v)})`;
  });
  // \x01 joins FIELDS and \x02 (below) joins ROWS — distinct separators, so a
  // field boundary can never collide with a row boundary and two different
  // row sets can never serialise to the same bytes. The original inline
  // version used raw control characters, which are invisible in most editors
  // and were nearly lost in this extraction — hence the escapes.
  return parts.join('\x01');
}

export interface TableFingerprint {
  rows: number;
  digest: string;
}

export interface DatabaseFingerprint {
  /** Keyed by table name, in TABLES order. */
  tables: Record<string, TableFingerprint>;
  /** One digest over the per-table digests — the WHOLE DATABASE line. */
  overall: string;
}

export async function fingerprintOf(db: Client): Promise<DatabaseFingerprint> {
  const tables: Record<string, TableFingerprint> = {};
  for (const table of TABLES) {
    const res = await db.execute(`select * from "${table}"`);
    const lines = res.rows.map((r) => canonical(r as unknown as Record<string, unknown>)).sort();
    const digest = createHash('sha256').update(lines.join('\x02')).digest('hex').slice(0, 16);
    tables[table] = { rows: res.rows.length, digest };
  }
  const overall = createHash('sha256')
    .update(TABLES.map((t) => `${t}=${tables[t].digest}`).join('|'))
    .digest('hex')
    .slice(0, 16);
  return { tables, overall };
}
