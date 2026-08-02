import type { RateObservation } from '../../types/contracts';

/**
 * FRED mortgage-rate fetcher — the deliberate, opt-in exception to "the only
 * outbound call is the SimpleFIN feed". One small GET during sync, carrying
 * the API key and a series id and nothing else: no account, transaction, or
 * balance data ever rides it (the trust card in `health/providers.ts` states
 * exactly this). Everything follows the shape sync-and-data-ops.md records
 * for a read-only external fetch:
 *
 *  - fetch on SYNC only (`refreshMortgageRate` is called from the sync
 *    pipeline, never on launch, never at render);
 *  - store the observation and render from the store (this module's Setting
 *    is the store; the readiness panel reads it, dated);
 *  - gate on an env var that FAILS CLOSED — no FRED_API_KEY means no fetch,
 *    no network call, and behavior identical to before this module existed;
 *  - key via env only, never the database, never logged.
 *
 * The series is OBMMIC30YF, verified against fred.stlouisfed.org 2026-08-02:
 * "30-Year Fixed Rate Conforming Mortgage Index", source Optimal Blue,
 * release "Optimal Blue Mortgage Market Indices", frequency Daily, units
 * Percent (not seasonally adjusted). Chosen over the weekly MORTGAGE30US
 * (Freddie Mac PMMS, "Weekly, Ending Thursday", application-based since
 * 2022-11-17) because locks and daily granularity are Optimal Blue's — the
 * PMMS averages a week and publishes Thursdays, so it is 0–6 days stale
 * about last week.
 */

/** Setting key holding the stored rate — the style goals.savings uses. */
export const MORTGAGE_RATE_KEY = 'rates.mortgage';

export const FRED_SERIES_ID = 'OBMMIC30YF';

/** Named in the trust card and the setup hint, beside the series id. */
export const FRED_SERIES_TITLE = '30-Year Fixed Rate Conforming Mortgage Index';

export const FRED_API_KEY_ENV = 'FRED_API_KEY';

const OBSERVATIONS_URL = 'https://api.stlouisfed.org/fred/series/observations';

/**
 * Observations requested per fetch, newest first. FRED publishes "." as the
 * value on days without a release, so "the latest observation" can sit a few
 * rows back — 8 covers a holiday weekend's run of placeholders with margin,
 * while staying a trivial payload.
 */
const OBSERVATION_LOOKBACK = 8;

/**
 * A fetch that hangs must not hold the whole sync hostage — the pipeline
 * waits on this call before regenerating insights. Ten seconds is generous
 * for a sub-kilobyte JSON response and a rounding error against the sync's
 * own feed fetch.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** Same bounds the typed rate is held to in `isReadinessConfig`. */
const isValidRatePct = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 30;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Setting's stored value. The last good observation and the last failure
 * are kept SIDE BY SIDE: a failed fetch must never cost the observation that
 * still stands (the reader keeps rendering it, dated), and a stored failure
 * is what lets provider health say WHY the observation stopped moving.
 */
export interface StoredMortgageRate {
  observation: RateObservation | null;
  lastError: { at: string; message: string } | null;
}

function isObservation(v: unknown): v is RateObservation {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.seriesId === 'string' &&
    o.seriesId.length > 0 &&
    isValidRatePct(o.ratePct) &&
    typeof o.observationDate === 'string' &&
    DATE_ONLY.test(o.observationDate) &&
    typeof o.fetchedAt === 'string' &&
    !Number.isNaN(Date.parse(o.fetchedAt))
  );
}

/** The stored Setting value → state; tolerant the way parseReadiness is. */
export function parseMortgageRate(raw: string | null): StoredMortgageRate | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const s = parsed as Record<string, unknown>;
    const observation = isObservation(s.observation) ? s.observation : null;
    const e = s.lastError as Record<string, unknown> | null | undefined;
    const lastError =
      typeof e === 'object' && e !== null && typeof e.at === 'string' && typeof e.message === 'string'
        ? { at: e.at, message: e.message }
        : null;
    if (observation === null && lastError === null) return null;
    return { observation, lastError };
  } catch {
    return null; // a corrupted setting must not take anything down
  }
}

/**
 * FRED's observations response → the newest usable value. Values arrive as
 * STRINGS and "." is the documented placeholder for a day with no release —
 * skipped, not parsed to NaN. Requested newest-first (sort_order=desc), so
 * the first row that survives the checks IS the latest observation.
 */
export function pickLatestObservation(body: unknown): { date: string; ratePct: number } | null {
  if (typeof body !== 'object' || body === null) return null;
  const observations = (body as Record<string, unknown>).observations;
  if (!Array.isArray(observations)) return null;
  for (const row of observations) {
    if (typeof row !== 'object' || row === null) continue;
    const { date, value } = row as Record<string, unknown>;
    if (typeof date !== 'string' || !DATE_ONLY.test(date)) continue;
    if (typeof value !== 'string' || value === '.') continue;
    const ratePct = Number(value);
    if (!isValidRatePct(ratePct)) continue;
    return { date, ratePct };
  }
  return null;
}

/** The two Setting operations this module needs — PrismaClient satisfies it,
 * and tests hand in a map-backed fake instead of a database. */
export interface SettingStore {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<{ key: string; value: string } | null>;
    upsert(args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
  };
}

export type RefreshOutcome =
  | { outcome: 'DISABLED' }
  | { outcome: 'STORED'; observation: RateObservation }
  | { outcome: 'FAILED'; message: string };

/**
 * The sync-pipeline step: fetch the latest observation and store it. Called
 * BEFORE insight regeneration so anything downstream of the store reads the
 * fresh value, and guaranteed to never throw — a rate fetch failing is a
 * recorded fact about the rate feed, never a reason a bank sync fails. On
 * failure the previous observation is kept whole, so the panel keeps
 * rendering the last real value beside its real date.
 *
 * Error messages are built from our own strings only: the request URL
 * carries the API key, so no error path may echo the URL or the response
 * into anything that gets stored or logged.
 */
export async function refreshMortgageRate(
  db: SettingStore,
  opts: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<RefreshOutcome> {
  const apiKey = process.env[FRED_API_KEY_ENV] ?? '';
  if (apiKey === '') return { outcome: 'DISABLED' }; // fails closed: no call, no write

  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  try {
    const row = await db.setting.findUnique({ where: { key: MORTGAGE_RATE_KEY } });
    const prior = parseMortgageRate(row?.value ?? null);

    let failure: string | null = null;
    let latest: { date: string; ratePct: number } | null = null;
    try {
      const url = new URL(OBSERVATIONS_URL);
      url.searchParams.set('series_id', FRED_SERIES_ID);
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('file_type', 'json');
      url.searchParams.set('sort_order', 'desc');
      url.searchParams.set('limit', String(OBSERVATION_LOOKBACK));
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        failure = `FRED returned HTTP ${res.status}`;
      } else {
        latest = pickLatestObservation((await res.json()) as unknown);
        if (latest === null) {
          failure = `no usable observation in the latest ${OBSERVATION_LOOKBACK} (series ${FRED_SERIES_ID})`;
        }
      }
    } catch (e) {
      failure = e instanceof Error && e.name === 'TimeoutError'
        ? `FRED request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : `fetch failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    const next: StoredMortgageRate =
      latest === null
        ? {
            observation: prior?.observation ?? null,
            lastError: { at: now.toISOString(), message: failure ?? 'unknown failure' },
          }
        : {
            observation: {
              seriesId: FRED_SERIES_ID,
              ratePct: latest.ratePct,
              observationDate: latest.date,
              fetchedAt: now.toISOString(),
            },
            lastError: null,
          };
    const value = JSON.stringify(next);
    await db.setting.upsert({
      where: { key: MORTGAGE_RATE_KEY },
      create: { key: MORTGAGE_RATE_KEY, value },
      update: { value },
    });
    return next.observation !== null && next.lastError === null
      ? { outcome: 'STORED', observation: next.observation }
      : { outcome: 'FAILED', message: failure ?? 'unknown failure' };
  } catch (e) {
    // Even a broken Setting table must not fail the sync from here — the
    // pipeline's own writes will say so with a better stack than this one.
    return { outcome: 'FAILED', message: e instanceof Error ? e.message : String(e) };
  }
}
