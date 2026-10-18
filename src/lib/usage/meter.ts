/**
 * What this instance spends against its hosts' free-plan limits, counted by the
 * app itself rather than read off a dashboard.
 *
 * Turso bills ROWS READ and ROWS WRITTEN, and its HTTP protocol reports both on
 * every statement result (`rows_read`, `rows_written`). The libSQL client
 * parses neither, but it takes a custom `fetch`, so `meteredFetch` reads them
 * off the response on the way past. The figures are therefore Turso's own, per
 * statement: the same quantity the plan limit is measured in, not an estimate
 * from row counts. A statement that comes back WITHOUT them is counted apart
 * (`turso.unreported`), so a host that stops reporting shows as a gap instead
 * of as zero.
 *
 * Counts collect in memory and reach the database in ONE upsert after the
 * response (`flushUsage`, scheduled by meterRequest.ts), never in the
 * request's own path. The flush's own rows land in the next flush.
 */

/** Which allowance a metric is measured against, and so how it is bucketed. */
export const USAGE_METRICS = {
  'turso.rowsRead': 'month',
  'turso.rowsWritten': 'month',
  'turso.statements': 'month',
  'turso.unreported': 'month',
  'app.requests': 'month',
  'simplefin.requests': 'day',
  // The first moment this month was counted, as epoch seconds, kept by MIN:
  // a month that started counting partway through says so instead of looking
  // quiet.
  'meter.since': 'month',
} as const;

export type UsageMetric = keyof typeof USAGE_METRICS;

/** "2026-10": the month key the allowances reset on (UTC). */
export function usageMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** "2026-10-17": a UTC day, for an allowance that resets daily. */
export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function periodOf(metric: UsageMetric, now: Date): string {
  return USAGE_METRICS[metric] === 'day' ? usageDay(now) : usageMonth(now);
}

interface MeterState {
  /** `${period}|${metric}` → count not yet written. */
  pending: Map<string, number>;
  /** The month this process last wrote meter.since for. */
  sinceMonth: string | null;
  flushing: boolean;
  warned: boolean;
}

// On globalThis, like the Prisma singleton: in dev a hot reload re-evaluates
// this module while the surviving client's fetch still points at the old one,
// and two Maps would split the counts between them.
const globalForMeter = globalThis as unknown as { ducatUsageMeter?: MeterState };

function state(): MeterState {
  globalForMeter.ducatUsageMeter ??= { pending: new Map(), sinceMonth: null, flushing: false, warned: false };
  return globalForMeter.ducatUsageMeter;
}

export function recordUsage(metric: UsageMetric, n: number, now: Date = new Date()): void {
  if (n === 0) return;
  const key = `${periodOf(metric, now)}|${metric}`;
  const pending = state().pending;
  pending.set(key, (pending.get(key) ?? 0) + n);
}

/** What is waiting to be written, for tests. */
export function pendingUsage(): Record<string, number> {
  return Object.fromEntries(state().pending);
}

export function resetUsageMeter(): void {
  delete globalForMeter.ducatUsageMeter;
}

export interface PipelineRows {
  statements: number;
  /** Statements that carried Turso's row counts. */
  reported: number;
  read: number;
  written: number;
}

/**
 * Turso's row counts, summed over every statement result in one pipeline
 * response body.
 *
 * Read off the TEXT with patterns rather than by parsing it a second time:
 * results can be megabytes of rows, and the client parses them anyway. The
 * patterns cannot match inside data, because JSON escapes a quote inside a
 * string (`\"rows_read\":`), and a column NAMED rows_read is followed by `"`
 * and `,` or `}`, never `":`.
 */
export function rowsInPipelineResponse(body: string): PipelineRows {
  const sum = (pattern: RegExp) => {
    let n = 0;
    let total = 0;
    for (const match of body.matchAll(pattern)) {
      n += 1;
      total += Number(match[1] ?? 0);
    }
    return { n, total };
  };
  const statements = sum(/"affected_row_count":\s*(\d+)/g).n;
  const read = sum(/"rows_read":\s*(\d+)/g);
  const written = sum(/"rows_written":\s*(\d+)/g);
  return { statements, reported: read.n, read: read.total, written: written.total };
}

/** Every pipeline endpoint a statement can go through (Hrana over HTTP). */
const PIPELINE_PATH = /\/v[23](-protobuf)?\/pipeline$/;

/**
 * `fetch` for the libSQL client: identical behaviour, plus Turso's row counts.
 *
 * Only a successful pipeline response is read; anything else passes through
 * untouched. The body is read once here and handed on as a fresh Response, so
 * the client still parses it exactly once.
 */
export async function meteredFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  const url = input instanceof Request ? input.url : String(input);
  const path = new URL(url).pathname;
  if (!response.ok || !PIPELINE_PATH.test(path)) return response;
  if (path.includes('-protobuf')) {
    // Only the JSON encoding carries the counts (the protobuf schema stops at
    // last_insert_rowid). A client that moved to it would otherwise count
    // nothing and show zero; this way the page names the gap.
    recordUsage('turso.statements', 1);
    recordUsage('turso.unreported', 1);
    return response;
  }
  const body = await response.text();
  const rows = rowsInPipelineResponse(body);
  recordUsage('turso.statements', rows.statements);
  recordUsage('turso.unreported', rows.statements - rows.reported);
  recordUsage('turso.rowsRead', rows.read);
  recordUsage('turso.rowsWritten', rows.written);
  const headers = new Headers();
  const type = response.headers.get('content-type');
  if (type !== null) headers.set('content-type', type);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** Runs one statement with positional arguments: Prisma's or a libSQL client's. */
export type SqlRunner = (sql: string, args: (string | number)[]) => Promise<unknown>;

/**
 * Writes everything pending in ONE statement, adding to what is stored.
 *
 * Never throws: a meter that could fail a page would be worse than none. A
 * failed write (the table not pushed to this database yet, a host that is
 * refusing) puts the counts back for the next flush and warns once.
 */
export async function flushUsage(run: SqlRunner, now: Date = new Date()): Promise<boolean> {
  const meter = state();
  if (meter.flushing) return false;
  const month = usageMonth(now);
  if (meter.sinceMonth !== month && meter.pending.size > 0) {
    meter.pending.set(`${month}|meter.since`, Math.floor(now.getTime() / 1000));
  }
  if (meter.pending.size === 0) return false;
  const entries = [...meter.pending];
  meter.pending.clear();
  meter.flushing = true;
  const args: (string | number)[] = [];
  for (const [key, n] of entries) {
    const bar = key.indexOf('|');
    args.push(key.slice(0, bar), key.slice(bar + 1), n);
  }
  const sql =
    `INSERT INTO "UsageCount" ("period", "metric", "count") VALUES ${entries.map(() => '(?, ?, ?)').join(', ')} ` +
    `ON CONFLICT ("period", "metric") DO UPDATE SET "count" = CASE WHEN "metric" = 'meter.since' ` +
    `THEN MIN("count", excluded."count") ELSE "count" + excluded."count" END`;
  try {
    await run(sql, args);
    meter.sinceMonth = month;
    return true;
  } catch (error) {
    for (const [key, n] of entries) {
      if (key.endsWith('|meter.since')) continue;
      meter.pending.set(key, (meter.pending.get(key) ?? 0) + n);
    }
    if (!meter.warned) {
      meter.warned = true;
      console.warn('Usage counts were not written:', error instanceof Error ? error.message : error);
    }
    return false;
  } finally {
    meter.flushing = false;
  }
}
