import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client';
import { prismaRunner } from '../prisma';
import { readUsage } from '../usage/limits';
import { flushUsage, recordUsage, resetUsageMeter } from '../usage/meter';
import { flaggedPerRow } from './queryPlans';
import { reseedDemo } from './reseed';
import { fileUrl, migrateFile } from './tempDatabase';
import { demoResetDue, recordDemoReset } from './resetDue';

/**
 * Every statement the demo's nightly job runs, checked against SQLite's own
 * query plan for work that repeats PER ROW.
 *
 * Turso bills rows read. A statement's first full scan is one pass over a
 * table; a full SCAN after it in the plan runs once for each row that pass
 * touches, which is quadratic. That is exactly what spent the free plan's
 * month on 2026-10-17: deleting 7,097 transactions planned as three scans of
 * Transaction, the delete's own and one per self-reference, ~100M rows read a
 * reset. scripts/foreignKeyIndexes.test.ts guards foreign keys by reading the
 * schema; this guards whatever the job actually RUNS, so a new filter or join
 * that scans per row fails here too.
 *
 * The control: the same statements planned against the schema WITHOUT the
 * foreign-key indexes must be flagged, or this test could not have caught the
 * bug it exists for.
 */

describe("the demo's nightly job reads no table once per row", () => {
  let dir: string;
  let indexed: string;
  let unindexed: string;
  const statements = new Map<string, unknown[]>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ducat-reset-plans-'));
    indexed = join(dir, 'indexed.db');
    unindexed = join(dir, 'unindexed.db');
    await migrateFile(indexed);
    await migrateFile(unindexed, (name) => !name.endsWith('_index_transaction_links'));

    const url = fileUrl(indexed);
    const prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url }),
      log: [{ emit: 'event', level: 'query' }],
    });
    prisma.$on('query', (e) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|PRAGMA|SAVEPOINT|RELEASE)/i.test(e.query) || statements.has(e.query)) return;
      const params = JSON.parse(e.params) as unknown[];
      statements.set(e.query, params.map((v) => (typeof v === 'boolean' ? Number(v) : v)));
    });

    // The job as the cron runs it: the hold's read, the decision, a reseed
    // over existing data (deletes have rows to check), the record, the meter.
    const first = new Date('2026-03-15T23:20:00Z');
    const second = new Date('2026-03-16T23:20:00Z');
    resetUsageMeter();
    await reseedDemo(prisma, first);
    await recordDemoReset(prisma, first);
    await readUsage(prisma, second);
    await demoResetDue(prisma, second);
    await reseedDemo(prisma, second);
    await recordDemoReset(prisma, second);
    recordUsage('app.requests', 1, second);
    await flushUsage(prismaRunner(prisma), second);
    resetUsageMeter();
    await prisma.$disconnect();
  }, 120_000);

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // On Windows libSQL's native handle outlives close() (copyDatabase.ts
      // retries renames for the same reason); a leftover temp folder is not a
      // failure of what this file tests.
    }
  });

  it('captures the job', () => {
    expect(statements.size).toBeGreaterThan(20);
    expect([...statements.keys()].some((sql) => /DELETE FROM `main`.`Transaction`/.test(sql))).toBe(true);
  });

  it('plans no full scan per row', async () => {
    expect(await flaggedPerRow(statements, indexed)).toEqual([]);
  });

  it('would have caught the reset that spent the month: the same job without the foreign-key indexes', async () => {
    const found = await flaggedPerRow(statements, unindexed);
    expect(found.some((f) => f.startsWith('DELETE FROM `main`.`Category`') && f.includes('SCAN Transaction'))).toBe(true);
    expect(found.some((f) => f.includes('SCAN Transaction, SCAN Transaction'))).toBe(true);
  });
});
