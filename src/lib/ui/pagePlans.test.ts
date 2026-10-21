import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client';
import { flaggedPerRow, planOf, topLevelFullScan, type Statements } from '../demo/queryPlans';
import { reseedDemo } from '../demo/reseed';
import { fileUrl, migrateFile } from '../demo/tempDatabase';

/**
 * Every statement a page's loader runs on the demo's data, checked against
 * SQLite's own query plan for the reads that grow with history.
 *
 * Turso bills rows read, and a page is read on every visit. Two shapes cost
 * more than they return:
 *   - a full scan that runs once per row of another (the shape that spent the
 *     hosting plan's month on 2026-10-17; demo/resetPlans.test.ts guards the
 *     nightly job the same way);
 *   - a full scan of Transaction under a statement that FILTERS or PAGES,
 *     where an index should have narrowed it. A statement with no filter reads
 *     the table on purpose (Trends draws every row) and is not flagged.
 *
 * The control plans the same statements against the schema WITHOUT the page
 * read indexes and must flag them, or this could not have caught the cost it
 * exists for.
 */

const held = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../prisma', async (importActual) => ({
  ...(await importActual<typeof import('../prisma')>()),
  prisma: new Proxy({}, { get: (_t, key) => (held.client as Record<PropertyKey, unknown>)[key] }),
}));

const INDEX_MIGRATION = '_index_page_reads';
const statements: Statements = new Map();
const failures: string[] = [];

let dir: string;
let indexed: string;
let unindexed: string;
const makeClient = (file: string) =>
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: fileUrl(file) }),
    log: [{ emit: 'event', level: 'query' }],
  });
let prisma: ReturnType<typeof makeClient>;

/** Runs one loader; a loader that throws is a failure of the guard, not a pass. */
async function load(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const noParams = (params: Record<string, string> = {}) => ({ searchParams: Promise.resolve(params) });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ducat-page-plans-'));
  indexed = join(dir, 'indexed.db');
  unindexed = join(dir, 'unindexed.db');
  await migrateFile(indexed);
  await migrateFile(unindexed, (name) => !name.endsWith(INDEX_MIGRATION));

  prisma = makeClient(indexed);
  held.client = prisma;
  const now = new Date();
  await reseedDemo(prisma, now);
  const month = now.toISOString().slice(0, 7);
  const tagged = await prisma.transaction.findFirst({ where: { groupLabel: { not: null } }, select: { groupLabel: true } });
  const account = await prisma.account.findFirstOrThrow({ select: { id: true } });
  const category = await prisma.category.findFirstOrThrow({ select: { id: true } });

  prisma.$on('query', (e) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|PRAGMA|SAVEPOINT|RELEASE)/i.test(e.query) || statements.has(e.query)) return;
    const params = JSON.parse(e.params) as unknown[];
    statements.set(e.query, params.map((v) => (typeof v === 'boolean' ? Number(v) : v)));
  });

  const { getOverviewData } = await import('./overview');
  const { getInsightsPageData } = await import('./insights');
  const { getTrendsSource } = await import('./trends');
  const { getAccountsData } = await import('./accounts');
  const { getProvidersData } = await import('./providers');
  const { getBudgetData } = await import('./budgetPage');
  const { default: TransactionsPage } = await import('../../app/transactions/page');

  await load('overview', () => getOverviewData());
  // Days 1 to 7 add the recap's reads; they must plan as cleanly as the rest.
  await load('overview (recap days)', () => getOverviewData(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 3, 12))));
  await load('insights', () => getInsightsPageData());
  await load('insights (a past month)', () => getInsightsPageData('2025-06'));
  await load('trends', () => getTrendsSource());
  await load('accounts', () => getAccountsData());
  await load('budget', () => getBudgetData());
  await load('providers', () => getProvidersData());
  await load('providers (history page)', () => getProvidersData({ connector: 'SIMPLEFIN', page: 2 }));
  // The ledger filters and pages on every control it has.
  const ledger: Record<string, string>[] = [
    {},
    { page: '2' },
    { period: month },
    { period: '2025' },
    { category: category.id },
    { category: 'uncategorized' },
    { account: account.id },
    { flow: 'OUTFLOW' },
    { q: 'market' },
    { review: '1' },
    ...(tagged?.groupLabel != null ? [{ group: tagged.groupLabel }] : []),
  ];
  for (const params of ledger) {
    await load(`ledger ${JSON.stringify(params)}`, () => TransactionsPage(noParams(params)));
  }
}, 240_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // libSQL's native handle outlives close() on Windows; a leftover temp
    // folder is not a failure of what this file tests.
  }
});

/**
 * Whether a Transaction read narrows or pages in a way an index serves: a real
 * page (ORDER BY with a LIMIT that is a number, not Prisma's -1 for "all"), or
 * a test of an indexed column by equality, membership, range or NULL.
 *
 * Not covered, on purpose: the ledger's whole-set reads for its totals and its
 * review queue (a flow test, a LIKE, an IS NOT NULL on a link column) read
 * every row they match by design, and no index on this table serves them.
 * Moving the totals to aggregates is backlog (docs/backlog.md).
 */
function narrowsOrPages(sql: string, params: unknown[]): boolean {
  const flat = sql.replace(/\s+/g, ' ');
  const limit = params.length >= 2 ? params[params.length - 2] : null;
  if (/ ORDER BY /.test(flat) && typeof limit === 'number' && limit > 0) return true;
  return /`(date|groupLabel|categoryId|accountId|transferPairId|importBatchId)` (= |IN |>= |> |<= |< |IS NULL)/.test(flat);
}

/** The statements that filter or page Transaction and plan a scan of all of it. */
async function wholeTableReads(file: string): Promise<string[]> {
  const out: string[] = [];
  for (const [sql, params] of statements) {
    if (!/^\s*SELECT/i.test(sql) || !/FROM `main`\.`Transaction`/.test(sql.replace(/\s+/g, ' '))) continue;
    if (!narrowsOrPages(sql, params)) continue;
    const scan = topLevelFullScan(await planOf(file, sql, params), 'Transaction');
    if (scan !== null) out.push(`${sql.replace(/\s+/g, ' ').split(' FROM ').slice(1).join(' FROM ').slice(0, 220)}  →  ${scan}`);
  }
  return out;
}

describe('every page reads no more than it returns', () => {
  it('ran every loader and captured their statements', () => {
    expect(failures).toEqual([]);
    expect(statements.size).toBeGreaterThan(40);
    const sql = [...statements.keys()].join('\n');
    // Content that is PRESENT: a loader that never ran would leave these out.
    for (const table of ['Insight', 'Transaction', 'BalanceSnapshot', 'SyncLog', 'Account']) {
      expect(sql).toContain(`\`main\`.\`${table}\``);
    }
  });

  it('plans no full scan per row', async () => {
    expect(await flaggedPerRow(statements, indexed)).toEqual([]);
  });

  it('plans no whole-table read of Transaction under a filter or a page', async () => {
    expect(await wholeTableReads(indexed)).toEqual([]);
  });

  it('would have caught the missing indexes: the same pages without them', async () => {
    const found = await wholeTableReads(unindexed);
    // The ledger's page (ORDER BY date) and a period filter (a range on date).
    expect(found.some((f) => f.includes('ORDER BY') && f.includes('`date`'))).toBe(true);
    expect(found.some((f) => f.includes('`date` >='))).toBe(true);
  });
});
