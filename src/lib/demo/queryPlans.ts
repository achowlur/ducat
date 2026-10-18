import { createClient, type InArgs } from '@libsql/client';
import { fileUrl } from './tempDatabase';

/**
 * Reading SQLite's own query plan for statements a job or a page ran. Turso
 * bills rows read, and a plan shows where a statement reads more than it
 * returns. Shared by the two guards that use it: demo/resetPlans.test.ts (the
 * nightly job) and ui/pagePlans.test.ts (every page's loader).
 */

export type PlanRow = { detail: string };
export type Statements = Map<string, unknown[]>;

/** Rows of a plan that name a table or index access (not literal rows). */
function accesses(plan: PlanRow[]): string[] {
  return (
    plan
      .map((p) => p.detail)
      // Literal rows are not a table: SQLite says "N-ROW VALUES CLAUSE", the
      // SQLite inside libSQL "N CONSTANT ROWS". Nor is a subquery's result
      // ("SCAN sub"), which Prisma's count() wraps its select in: the table
      // under it is the access that counts.
      .filter((d) => /^(SCAN|SEARCH) /.test(d) && !/^SCAN (CONSTANT ROW|\d+ CONSTANT ROWS|\d+-ROW VALUES CLAUSE|\(|sub\b)/.test(d))
  );
}

/** Full scans that run per row: every SCAN of a table after the statement's own pass. */
export function perRowScans(sql: string, plan: PlanRow[]): string[] {
  // An INSERT has no pass of its own: anything it scans, it scans per row.
  const own = /^\s*INSERT/i.test(sql) ? 0 : 1;
  return accesses(plan).slice(own).filter((d) => d.startsWith('SCAN '));
}

/**
 * The statement's OUTERMOST access, when it is a scan of `table` that walks
 * the whole table: no index named, so every row is read. A scan USING an
 * index is an ordered walk a LIMIT can stop; it is not flagged here.
 */
export function topLevelFullScan(plan: PlanRow[], table: string): string | null {
  const first = accesses(plan)[0];
  if (first === undefined) return null;
  const whole = new RegExp(`^SCAN (\`?main\`?\.)?\`?${table}\`?( AS \w+)?$`);
  return whole.test(first) ? first : null;
}

export async function planOf(file: string, sql: string, params: unknown[]): Promise<PlanRow[]> {
  const db = createClient({ url: fileUrl(file) });
  try {
    return (await db.execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args: params as InArgs })).rows as unknown as PlanRow[];
  } finally {
    db.close();
  }
}

/** Statements whose plan on `file` scans a table once per row. */
export async function flaggedPerRow(statements: Statements, file: string): Promise<string[]> {
  const out: string[] = [];
  for (const [sql, params] of statements) {
    const scans = perRowScans(sql, await planOf(file, sql, params));
    if (scans.length > 0) out.push(`${sql.slice(0, 90)}  →  ${scans.join(', ')}`);
  }
  return out;
}
