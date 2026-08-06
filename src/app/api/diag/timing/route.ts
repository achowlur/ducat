import { prisma } from "../../../../lib/prisma";
import { requireSession } from "../../../../lib/auth/requireSession";
import { databaseFailure } from "../../../../lib/ui/dbHealth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Where a page's server time actually goes, measured ON THE DEPLOYMENT.
 *
 * Localhost cannot answer this: no network, no cold start, and a `file:`
 * database instead of HTTP round trips to Turso. Three wrong diagnoses came
 * from trusting a local time number, so this exists to make the real one
 * routine rather than a one-off.
 *
 * A route handler and not the page itself because App Router pages cannot set
 * response headers — only middleware (which returns before the render) and
 * next.config (static) can. So this mirrors the queries `/transactions` issues
 * and reports them, and React's render time falls out by subtraction:
 * DevTools TTFB − `pagePaysMs` − middleware ≈ render.
 *
 * Sends nothing anywhere. It is a read-only endpoint the operator queries,
 * session-gated like every other page (middleware allow-lists only
 * `/api/cron/*`), and beyond one `SELECT 1` it runs no query the transactions
 * page doesn't already.
 *
 * Read `connectMs` before anything else, and read a small `msSinceFunctionBoot`
 * as "discard this sample". Absolute ms drift about 2x between batches on
 * identical code, so compare a query against the trivial ones in the SAME
 * response rather than against a number written down last week.
 */

/** Module scope: a small value means this invocation paid a cold start. */
const bootedAt = Date.now();

const PAGE_SIZE = 100;
const CANDIDATE_POOL_TAKE = 2000;

const round = (ms: number): number => Math.round(ms * 10) / 10;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const t0 = performance.now();
  const result = await fn();
  return { ms: round(performance.now() - t0), result };
}

/**
 * The six queries `/transactions` issues in its `Promise.all`, defined ONCE and
 * run in both arrangements below.
 *
 * Defining them twice is exactly how this endpoint lied: the concurrent copy
 * silently kept an `include: { category, account, reimburses }` that the
 * sequential copy had already dropped, so a 9-statement block was being
 * compared against a 7-statement one. That nearly shipped the conclusion that
 * `Promise.all` makes things worse. One definition, two arrangements — the
 * divergence is now structurally impossible rather than merely unlikely.
 *
 * Each returns the number of rows it fetched (0 where that is meaningless), so
 * the report can state what came back without holding onto the rows.
 */
const PAGE_QUERIES: { name: string; run: () => Promise<number> }[] = [
  {
    name: "rows",
    run: async () =>
      (
        await prisma.transaction.findMany({
          select: {
            id: true,
            date: true,
            amount: true,
            flow: true,
            description: true,
            normalizedMerchant: true,
            accountId: true,
            categoryId: true,
            categorySource: true,
            reimbursesId: true,
            reimburses: { select: { normalizedMerchant: true, description: true, date: true } },
          },
          orderBy: { date: "desc" },
          take: PAGE_SIZE,
        })
      ).length,
  },
  { name: "count", run: () => prisma.transaction.count() },
  { name: "categories", run: async () => (await prisma.category.findMany({ orderBy: { name: "asc" } })).length },
  { name: "accounts", run: async () => (await prisma.account.findMany({ orderBy: { name: "asc" } })).length },
  {
    name: "dateRange",
    run: async () => {
      await prisma.transaction.aggregate({ _min: { date: true }, _max: { date: true } });
      return 0;
    },
  },
  {
    name: "reviewPool",
    run: async () =>
      (
        await prisma.transaction.findMany({
          where: { categoryId: null, reimbursesId: null, flow: { not: "TRANSFER" } },
          select: { id: true, normalizedMerchant: true, description: true },
        })
      ).length,
  },
];

/** The candidate pool, which the page cannot put in the group — its date window comes from the fetched rows. */
const candidatePool = async (): Promise<number> =>
  (
    await prisma.transaction.findMany({
      where: { flow: "OUTFLOW" },
      select: {
        id: true,
        amount: true,
        date: true,
        categoryId: true,
        normalizedMerchant: true,
        description: true,
      },
      orderBy: { date: "desc" },
      take: CANDIDATE_POOL_TAKE,
    })
  ).length;

async function runSequentially(): Promise<number> {
  const t0 = performance.now();
  for (const q of PAGE_QUERIES) await q.run();
  return round(performance.now() - t0);
}

async function runConcurrently(): Promise<number> {
  const t0 = performance.now();
  await Promise.all(PAGE_QUERIES.map((q) => q.run()));
  return round(performance.now() - t0);
}

/** Host or "local file", defensively — a malformed URL must not throw in the catch. */
function databaseName(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("libsql://")) return "local file";
  try {
    return new URL(url).host;
  } catch {
    return "unparseable DATABASE_URL";
  }
}

/**
 * This endpoint is READ DURING AN OUTAGE — probing it was one of the three
 * steps the 2026-08-04 diagnosis actually took — and it used to answer that
 * moment with an unhandled rejection and a 500, which says nothing. It now
 * reports the condition in the same terms the pages do, from the same
 * classifier, so the two cannot disagree about what is wrong.
 *
 * Note what this does NOT fix, because it cannot: `connectMs` below times a
 * bare `SELECT 1`, which SQLite answers without opening any table — so it
 * succeeds against a reachable database that has no schema at all (measured).
 * A healthy `connectMs` is evidence of a reachable server and nothing more.
 * The queries after it are what discover a missing table, and now they say so.
 */
export async function GET(): Promise<Response> {
  await requireSession();
  try {
    return await measure();
  } catch (error) {
    const failure = databaseFailure(error);
    // A bug still 500s. Dressing one up as an outage here would repeat the
    // mistake this whole classifier exists to end, one layer down.
    if (failure === null) throw error;
    return Response.json(
      {
        database: databaseName(),
        region: process.env.VERCEL_REGION ?? "local",
        msSinceFunctionBoot: Date.now() - bootedAt,
        // Named, not diagnosed: this cannot tell a provider incident from a
        // revoked token from a lapsed plan, and neither can the pages.
        failure: failure.kind,
        reported: failure.detail,
        measurements: null,
        // "the database did not answer" was wrong for `no-tables`, where it
        // answered perfectly well and simply lacks the table. This says only
        // what is true of every kind.
        note: "No timings were taken: the probe queries could not run.",
      },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

async function measure(): Promise<Response> {
  // The first database call of a request absorbs connection setup, and whatever
  // runs first wears it. That is not a subtle effect: `rows` once reported
  // 194.1ms in a response whose concurrent group — which runs that same query —
  // took 72.7ms. Paying it here, on a query that touches no data, is what lets
  // everything below measure itself. Timed rather than hidden: on a cold
  // invocation this is where the ~600-800ms goes, and that belongs on the report.
  const connect = await timed(() => prisma.$queryRaw`SELECT 1`);

  // --- A1: the six, one after another, with each one's own cost visible. -----
  const perQuery: { name: string; ms: number; rows: number }[] = [];
  const a1Start = performance.now();
  for (const q of PAGE_QUERIES) {
    const t = await timed(q.run);
    perQuery.push({ name: q.name, ms: t.ms, rows: t.result });
  }
  const a1 = round(performance.now() - a1Start);

  // --- B1, B2, A2: the ordering experiment. ---------------------------------
  // ABBA, not AB. Running sequential-then-concurrent once cannot distinguish
  // "concurrent is slower" from "whatever runs second is slower" — page cache
  // favours the second block, request-lifetime effects penalise it, and a
  // single ordering confounds both with the thing being measured. With A at
  // positions 1 and 4 and B at 2 and 3, both average position 2.5, so any
  // drift that is linear across the request cancels out of the comparison.
  const b1 = await runConcurrently();
  const b2 = await runConcurrently();
  const a2 = await runSequentially();

  const sequentialMean = round((a1 + a2) / 2);
  const concurrentMean = round((b1 + b2) / 2);

  // Last, so it sits outside the experiment rather than between its blocks.
  const pool = await timed(candidatePool);

  const rowsOf = (name: string): number => perQuery.find((q) => q.name === name)?.rows ?? 0;

  const body = {
    database: databaseName(),
    region: process.env.VERCEL_REGION ?? "local",
    // Small = this request paid a cold start, which is worth knowing before
    // reading anything else here as typical.
    msSinceFunctionBoot: Date.now() - bootedAt,
    // The request's first database call, on a query that reads nothing. Large
    // means this request established a connection; everything below is then
    // measuring itself rather than inheriting it.
    connectMs: connect.ms,
    sequential: Object.fromEntries(perQuery.map((q) => [q.name, q.ms])),
    candidatePoolMs: pool.ms,
    ordering: {
      design: "ABBA: sequential, concurrent, concurrent, sequential — a linear drift across the request cancels",
      sequentialMs: [a1, a2],
      concurrentMs: [b1, b2],
      sequentialMeanMs: sequentialMean,
      concurrentMeanMs: concurrentMean,
      // Above 1 means the Promise.all is earning its place; below 1 means the
      // six queries contend rather than overlap and the page would be faster
      // running them one after another.
      concurrentSpeedup:
        concurrentMean === 0 ? null : Math.round((sequentialMean / concurrentMean) * 100) / 100,
    },
    // What /transactions pays for data TODAY: the concurrent group, then the
    // candidate pool, which is serialized because it needs the fetched rows.
    pagePaysMs: round(concurrentMean + pool.ms),
    // And what it would pay with the same queries run one after another, which
    // is the decision `ordering` above is evidence for.
    pageWouldPaySequentiallyMs: round(sequentialMean + pool.ms),
    rowsReturned: {
      page: rowsOf("rows"),
      total: rowsOf("count"),
      categories: rowsOf("categories"),
      accounts: rowsOf("accounts"),
      reviewPool: rowsOf("reviewPool"),
      candidatePool: pool.result,
    },
  };

  return Response.json(body, {
    headers: {
      // DevTools renders this under Network → Timing → Server Timing.
      "Server-Timing": [
        `total;desc="data the page pays for";dur=${body.pagePaysMs}`,
        `concurrent;desc="6 queries in one Promise.all";dur=${concurrentMean}`,
        `sequentialSix;desc="the same 6, one after another";dur=${sequentialMean}`,
        `pool;desc="candidate pool (serialized)";dur=${body.candidatePoolMs}`,
        `connect;desc="first call of the request";dur=${body.connectMs}`,
        ...perQuery.map((q) => `${q.name};dur=${q.ms}`),
      ].join(", "),
      "Cache-Control": "private, no-store",
    },
  });
}
