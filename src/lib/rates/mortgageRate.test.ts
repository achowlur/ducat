import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FRED_SERIES_ID,
  MORTGAGE_RATE_KEY,
  parseMortgageRate,
  pickLatestObservation,
  refreshMortgageRate,
  type SettingStore,
  type StoredMortgageRate,
} from './mortgageRate';

const NOW = new Date(Date.UTC(2026, 7, 2, 12));

/** Map-backed SettingStore: what the fetcher stored is what the map holds. */
function makeStore(initial?: StoredMortgageRate) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(MORTGAGE_RATE_KEY, JSON.stringify(initial));
  const store: SettingStore = {
    setting: {
      findUnique: ({ where }) => {
        const value = map.get(where.key);
        return Promise.resolve(value === undefined ? null : { key: where.key, value });
      },
      upsert: ({ where, create, update }) => {
        map.set(where.key, map.has(where.key) ? update.value : create.value);
        return Promise.resolve({});
      },
    },
  };
  return { store, map };
}

const stored = (map: Map<string, string>): StoredMortgageRate | null =>
  parseMortgageRate(map.get(MORTGAGE_RATE_KEY) ?? null);

/** FRED's JSON shape, values as STRINGS, newest first (sort_order=desc). */
const fredBody = (rows: [string, string][]) => ({
  observations: rows.map(([date, value]) => ({ date, value })),
});

const respond = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const PRIOR: StoredMortgageRate = {
  observation: {
    seriesId: FRED_SERIES_ID,
    ratePct: 6.6,
    observationDate: '2026-07-20',
    fetchedAt: '2026-07-21T23:15:00.000Z',
  },
  lastError: null,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('refreshMortgageRate — the gate fails closed', () => {
  it('makes NO fetch and NO write without FRED_API_KEY', async () => {
    vi.stubEnv('FRED_API_KEY', '');
    const { store, map } = makeStore();
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await refreshMortgageRate(store, { fetchImpl, now: NOW });
    expect(result).toEqual({ outcome: 'DISABLED' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });
});

describe('refreshMortgageRate — fetch and store', () => {
  it('stores the newest numeric observation, skipping "." placeholders', async () => {
    vi.stubEnv('FRED_API_KEY', 'test-key');
    const { store, map } = makeStore();
    // A weekend: the two newest rows are "." — the real latest sits behind them.
    const fetchImpl = vi.fn<typeof fetch>(() =>
      respond(
        fredBody([
          ['2026-08-01', '.'],
          ['2026-07-31', '.'],
          ['2026-07-30', '6.651'],
          ['2026-07-29', '6.658'],
        ]),
      ),
    );
    const result = await refreshMortgageRate(store, { fetchImpl, now: NOW });
    expect(result.outcome).toBe('STORED');
    expect(stored(map)).toEqual({
      observation: {
        seriesId: FRED_SERIES_ID,
        ratePct: 6.651,
        observationDate: '2026-07-30',
        fetchedAt: NOW.toISOString(),
      },
      lastError: null,
    });
  });

  it('asks for the series newest-first with the key from env, nothing else', async () => {
    vi.stubEnv('FRED_API_KEY', 'test-key');
    const { store } = makeStore();
    const fetchImpl = vi.fn<typeof fetch>(() => respond(fredBody([['2026-07-30', '6.651']])));
    await refreshMortgageRate(store, { fetchImpl, now: NOW });
    const url = fetchImpl.mock.calls[0][0] as URL;
    expect(url.origin).toBe('https://api.stlouisfed.org');
    expect(url.pathname).toBe('/fred/series/observations');
    expect(url.searchParams.get('series_id')).toBe(FRED_SERIES_ID);
    expect(url.searchParams.get('api_key')).toBe('test-key');
    expect(url.searchParams.get('sort_order')).toBe('desc');
    expect(url.searchParams.get('file_type')).toBe('json');
  });

  it('a window of nothing but placeholders records a failure, not a NaN rate', async () => {
    vi.stubEnv('FRED_API_KEY', 'test-key');
    const { store, map } = makeStore(PRIOR);
    const fetchImpl = vi.fn<typeof fetch>(() =>
      respond(fredBody([['2026-08-01', '.'], ['2026-07-31', '.']])),
    );
    const result = await refreshMortgageRate(store, { fetchImpl, now: NOW });
    expect(result.outcome).toBe('FAILED');
    const after = stored(map);
    expect(after?.observation).toEqual(PRIOR.observation); // last good value stands
    expect(after?.lastError?.message).toContain('no usable observation');
  });
});

describe('refreshMortgageRate — failure never loses the last observation', () => {
  const failureCases: [string, () => Promise<Response>][] = [
    ['HTTP error (revoked key)', () => respond({ error_message: 'Bad Request' }, 400)],
    ['network failure', () => Promise.reject(new Error('getaddrinfo ENOTFOUND'))],
    ['malformed body', () => Promise.resolve(new Response('<!doctype html>', { status: 200 }))],
    ['unexpected shape', () => respond({ observations: 'not-an-array' })],
    ['out-of-range values', () => respond(fredBody([['2026-07-30', '0'], ['2026-07-29', '99']]))],
  ];

  for (const [name, impl] of failureCases) {
    it(`${name}: records the failure and keeps the prior observation whole`, async () => {
      vi.stubEnv('FRED_API_KEY', 'test-key');
      const { store, map } = makeStore(PRIOR);
      const result = await refreshMortgageRate(store, { fetchImpl: vi.fn<typeof fetch>(impl), now: NOW });
      expect(result.outcome).toBe('FAILED');
      const after = stored(map);
      expect(after?.observation).toEqual(PRIOR.observation);
      expect(after?.lastError?.at).toBe(NOW.toISOString());
      expect(after?.lastError?.message).toBeTruthy();
    });
  }

  it('a first-ever failure stores the error alone, and never echoes the URL', async () => {
    vi.stubEnv('FRED_API_KEY', 'secret-key');
    const { store, map } = makeStore();
    await refreshMortgageRate(store, {
      fetchImpl: vi.fn<typeof fetch>(() => respond({}, 500)),
      now: NOW,
    });
    const after = stored(map);
    expect(after?.observation).toBeNull();
    expect(after?.lastError?.message).toBe('FRED returned HTTP 500');
    // The raw stored value must not carry the key anywhere.
    expect(map.get(MORTGAGE_RATE_KEY)).not.toContain('secret-key');
  });

  it('a store that cannot even be read reports FAILED instead of throwing', async () => {
    vi.stubEnv('FRED_API_KEY', 'test-key');
    const broken: SettingStore = {
      setting: {
        findUnique: () => Promise.reject(new Error('database is locked')),
        upsert: () => Promise.reject(new Error('database is locked')),
      },
    };
    const result = await refreshMortgageRate(broken, { fetchImpl: vi.fn<typeof fetch>(), now: NOW });
    expect(result).toEqual({ outcome: 'FAILED', message: 'database is locked' });
  });
});

describe('pickLatestObservation', () => {
  it('rejects non-objects and shapeless bodies', () => {
    expect(pickLatestObservation(null)).toBeNull();
    expect(pickLatestObservation('[]')).toBeNull();
    expect(pickLatestObservation({})).toBeNull();
    expect(pickLatestObservation({ observations: {} })).toBeNull();
  });

  it('skips rows with bad dates, non-string values and "." before accepting', () => {
    expect(
      pickLatestObservation({
        observations: [
          { date: 'Jul 30 2026', value: '6.9' },
          { date: '2026-07-30', value: 6.9 },
          { date: '2026-07-30', value: '.' },
          { date: '2026-07-29', value: '6.658' },
        ],
      }),
    ).toEqual({ date: '2026-07-29', ratePct: 6.658 });
  });
});

describe('parseMortgageRate', () => {
  it('round-trips a stored value', () => {
    expect(parseMortgageRate(JSON.stringify(PRIOR))).toEqual(PRIOR);
  });

  it('survives corruption rather than taking anything down', () => {
    expect(parseMortgageRate(null)).toBeNull();
    expect(parseMortgageRate('not json')).toBeNull();
    expect(parseMortgageRate('[]')).toBeNull();
    expect(parseMortgageRate('{}')).toBeNull(); // neither observation nor error
    expect(
      parseMortgageRate(JSON.stringify({ observation: { seriesId: '', ratePct: 6.6 }, lastError: null })),
    ).toBeNull();
  });

  it('drops an out-of-range or misdated observation but keeps the error beside it', () => {
    const bad = parseMortgageRate(
      JSON.stringify({
        observation: { ...PRIOR.observation, ratePct: 45 },
        lastError: { at: '2026-08-01T00:00:00.000Z', message: 'boom' },
      }),
    );
    expect(bad?.observation).toBeNull();
    expect(bad?.lastError?.message).toBe('boom');
  });
});
