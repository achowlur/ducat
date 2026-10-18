import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushUsage, meteredFetch, pendingUsage, recordUsage, resetUsageMeter, rowsInPipelineResponse } from './meter';

/**
 * The meter reads Turso's own row counts off each response. The shapes below
 * are the Hrana-over-HTTP JSON a pipeline returns (HRANA_3_SPEC, StmtResult:
 * rows_read, rows_written), with invented values.
 */
const stmt = (read: number, written: number, rows: unknown[][] = []) => ({
  cols: [{ name: 'v', decltype: 'TEXT' }],
  rows,
  affected_row_count: written,
  last_insert_rowid: null,
  rows_read: read,
  rows_written: written,
  query_duration_ms: 0.4,
});

const pipeline = (...results: unknown[]) =>
  JSON.stringify({ baton: null, base_url: null, results: results.map((response) => ({ type: 'ok', response })) });

describe('rowsInPipelineResponse', () => {
  it('sums every statement, inside a batch or not', () => {
    const body = pipeline(
      { type: 'execute', result: stmt(120, 0) },
      { type: 'batch', result: { step_results: [stmt(7, 1), null, stmt(3, 2)], step_errors: [null, null, null] } },
      { type: 'close' },
    );
    expect(rowsInPipelineResponse(body)).toEqual({ statements: 3, reported: 3, read: 130, written: 3 });
  });

  it('never counts the words inside the data: a value or a column can be named rows_read', () => {
    const result = { ...stmt(5, 0, [[{ type: 'text', value: '"rows_read":999999' }]]), cols: [{ name: 'rows_read', decltype: null }] };
    expect(rowsInPipelineResponse(pipeline({ type: 'execute', result })).read).toBe(5);
  });

  it('tells a statement the host did not report apart from one that read nothing', () => {
    const bare: Partial<ReturnType<typeof stmt>> = stmt(0, 0);
    delete bare.rows_read;
    delete bare.rows_written;
    expect(rowsInPipelineResponse(pipeline({ type: 'execute', result: bare }))).toEqual({
      statements: 1,
      reported: 0,
      read: 0,
      written: 0,
    });
  });
});

describe('meteredFetch', () => {
  beforeEach(() => resetUsageMeter());
  afterEach(() => {
    vi.unstubAllGlobals();
    resetUsageMeter();
  });

  it('hands the real libSQL client a response it reads exactly as before, and counts its rows', async () => {
    const body = pipeline({ type: 'execute', result: stmt(42, 0, [[{ type: 'text', value: 'hello' }]]) }, { type: 'close' });
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: Request) => {
      seen.push(new URL(input.url).pathname);
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = createClient({ url: 'http://db.example.test', fetch: meteredFetch });
    const result = await client.execute('select v from t');
    client.close();

    expect(seen).toEqual(['/v2/pipeline']);
    expect(result.rows[0].v).toBe('hello');
    const now = new Date().toISOString().slice(0, 7);
    expect(pendingUsage()).toEqual({
      [`${now}|turso.statements`]: 1,
      [`${now}|turso.rowsRead`]: 42,
    });
  });

  it('names a response in an encoding that carries no counts, instead of counting it as nothing', async () => {
    const binary = new Response(new Uint8Array([10, 2, 8, 1]), {
      status: 200,
      headers: { 'content-type': 'application/x-protobuf' },
    });
    vi.stubGlobal('fetch', async () => binary);
    expect(await meteredFetch('http://db.example.test/v3-protobuf/pipeline', { method: 'POST' })).toBe(binary);
    const month = new Date().toISOString().slice(0, 7);
    expect(pendingUsage()).toEqual({ [`${month}|turso.statements`]: 1, [`${month}|turso.unreported`]: 1 });
  });

  it('passes anything that is not a successful pipeline through untouched', async () => {
    const refused = new Response('{"error":"BLOCKED"}', { status: 400 });
    vi.stubGlobal('fetch', async () => refused);
    expect(await meteredFetch('http://db.example.test/v2/pipeline', { method: 'POST' })).toBe(refused);
    expect(pendingUsage()).toEqual({});
  });
});

describe('flushUsage', () => {
  beforeEach(() => resetUsageMeter());
  afterEach(() => resetUsageMeter());
  const NOW = new Date('2026-03-14T12:00:00Z');

  it('writes everything pending in one statement that adds to what is stored', async () => {
    recordUsage('turso.rowsRead', 1500, NOW);
    recordUsage('simplefin.requests', 1, NOW);
    const calls: { sql: string; args: (string | number)[] }[] = [];
    expect(await flushUsage(async (sql, args) => calls.push({ sql, args }), NOW)).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('ON CONFLICT ("period", "metric") DO UPDATE');
    expect(calls[0].sql).toContain('"count" + excluded."count"');
    expect(calls[0].args).toEqual([
      '2026-03', 'turso.rowsRead', 1500,
      '2026-03-14', 'simplefin.requests', 1,
      '2026-03', 'meter.since', Math.floor(NOW.getTime() / 1000),
    ]);
    expect(pendingUsage()).toEqual({});
  });

  it('marks when counting began once a month, not on every flush', async () => {
    const calls: (string | number)[][] = [];
    const run = async (_sql: string, args: (string | number)[]) => calls.push(args);
    recordUsage('app.requests', 1, NOW);
    await flushUsage(run, NOW);
    recordUsage('app.requests', 1, NOW);
    await flushUsage(run, NOW);
    expect(calls[1]).toEqual(['2026-03', 'app.requests', 1]);
  });

  it('does nothing when nothing is pending', async () => {
    const run = vi.fn(async () => undefined);
    expect(await flushUsage(run, NOW)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('never throws, and keeps the counts for the next flush when the write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    recordUsage('turso.rowsWritten', 9, NOW);
    expect(await flushUsage(async () => Promise.reject(new Error('no such table: UsageCount')), NOW)).toBe(false);
    expect(pendingUsage()).toEqual({ '2026-03|turso.rowsWritten': 9 });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
