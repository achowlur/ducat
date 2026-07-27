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
 * `/api/cron/*`), and it runs no query the transactions page doesn't already.
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

  // Individually and sequentially, so each round trip's own cost is visible.
  const rows = await timed("rows", () =>
    prisma.transaction.findMany({
      include: { category: true, account: true, reimburses: true },
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
    sequential: Object.fromEntries(sequential.map((s) => [s.name, s.ms])),
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
        ...sequential.map((s) => `${s.name};dur=${s.ms}`),
      ].join(", "),
      "Cache-Control": "private, no-store",
    },
  });
}
