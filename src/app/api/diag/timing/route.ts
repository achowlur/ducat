import { prisma } from "../../../../lib/prisma";
import { requireSession } from "../../../../lib/auth/requireSession";

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
 * DevTools TTFB − `totalMs` − middleware ≈ render.
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

async function timed<T>(name: string, fn: () => Promise<T>): Promise<{ name: string; ms: number; result: T }> {
  const t0 = performance.now();
  const result = await fn();
  return { name, ms: Math.round((performance.now() - t0) * 10) / 10, result };
}

export async function GET(): Promise<Response> {
  await requireSession();

  // The first database call of a request absorbs connection setup, and whatever
  // runs first wears it. That is not a subtle effect: `rows` once reported
  // 194.1ms in a response whose `parallelGroupMs` was 72.7ms — and the parallel
  // group RUNS THAT SAME QUERY, so 194.1ms was never its intrinsic cost.
  // Paying it here, on a query that touches no data, is what lets the seven
  // below measure themselves. Timed rather than hidden: on a cold invocation
  // this is where the ~600-800ms goes, and that belongs on the report.
  const connect = await timed("connect", () => prisma.$queryRaw`SELECT 1`);

  // Individually and sequentially, so each round trip's own cost is visible.
  const rows = await timed("rows", () =>
    prisma.transaction.findMany({
      // Mirrors the page: `category` is unused since the picker took over,
      // `account` names come from the accounts array, and only `reimburses`
      // still costs a relation query.
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
    }),
  );
  const count = await timed("count", () => prisma.transaction.count());
  const categories = await timed("categories", () => prisma.category.findMany({ orderBy: { name: "asc" } }));
  const accounts = await timed("accounts", () => prisma.account.findMany({ orderBy: { name: "asc" } }));
  const dateRange = await timed("dateRange", () =>
    prisma.transaction.aggregate({ _min: { date: true }, _max: { date: true } }),
  );
  const reviewPool = await timed("reviewPool", () =>
    prisma.transaction.findMany({
      where: { categoryId: null, reimbursesId: null, flow: { not: "TRANSFER" } },
      select: { id: true, normalizedMerchant: true, description: true },
    }),
  );
  const pool = await timed("candidatePool", () =>
    prisma.transaction.findMany({
      where: { flow: "OUTFLOW" },
      // Scalars only, matching the page. Category names are resolved there from
      // the `categories` array rather than joined per row.
      select: {
        id: true,
        amount: true,
        date: true,
        categoryId: true,
        normalizedMerchant: true,
        description: true,
      },
      orderBy: { date: "desc" },
      take: 2000,
    }),
  );
  const sequential = [rows, count, categories, accounts, dateRange, reviewPool, pool];

  // And again in the shape the page actually uses, because six concurrent round
  // trips cost about the slowest one rather than their sum — the difference
  // between these two numbers IS the value of the Promise.all.
  const parallel = await timed("parallelGroup", () =>
    Promise.all([
      prisma.transaction.findMany({
        include: { category: true, account: true, reimburses: true },
        orderBy: { date: "desc" },
        take: PAGE_SIZE,
      }),
      prisma.transaction.count(),
      prisma.category.findMany({ orderBy: { name: "asc" } }),
      prisma.account.findMany({ orderBy: { name: "asc" } }),
      prisma.transaction.aggregate({ _min: { date: true }, _max: { date: true } }),
      prisma.transaction.findMany({
        where: { categoryId: null, reimbursesId: null, flow: { not: "TRANSFER" } },
        select: { id: true, normalizedMerchant: true, description: true },
      }),
    ]),
  );

  const url = process.env.DATABASE_URL ?? "";
  const body = {
    database: url.startsWith("libsql://") ? new URL(url).host : "local file",
    region: process.env.VERCEL_REGION ?? "local",
    // Small = this request paid a cold start, which is worth knowing before
    // reading anything else here as typical.
    msSinceFunctionBoot: Date.now() - bootedAt,
    // The request's first database call, on a query that reads nothing. Large
    // means this request established a connection; the seven below are then
    // measuring themselves rather than inheriting it.
    connectMs: connect.ms,
    sequential: Object.fromEntries(sequential.map((s) => [s.name, s.ms])),
    // Now a real "if these ran one after another" figure, which it was not
    // while the first entry was carrying connection setup.
    sequentialTotalMs: Math.round(sequential.reduce((sum, s) => sum + s.ms, 0) * 10) / 10,
    parallelGroupMs: parallel.ms,
    candidatePoolMs: pool.ms,
    // What /transactions actually pays for data: the parallel group, then the
    // candidate pool, which is serialized because it needs the fetched rows.
    pagePaysMs: Math.round((parallel.ms + pool.ms) * 10) / 10,
    rowsReturned: {
      page: rows.result.length,
      total: count.result,
      categories: categories.result.length,
      accounts: accounts.result.length,
      reviewPool: reviewPool.result.length,
      candidatePool: pool.result.length,
    },
  };

  return Response.json(body, {
    headers: {
      // DevTools renders this under Network → Timing → Server Timing.
      "Server-Timing": [
        `total;desc="data the page pays for";dur=${body.pagePaysMs}`,
        `parallel;desc="6 concurrent queries";dur=${body.parallelGroupMs}`,
        `pool;desc="candidate pool (serialized)";dur=${body.candidatePoolMs}`,
        `connect;desc="first call of the request";dur=${body.connectMs}`,
        ...sequential.map((s) => `${s.name};dur=${s.ms}`),
      ].join(", "),
      "Cache-Control": "private, no-store",
    },
  });
}
