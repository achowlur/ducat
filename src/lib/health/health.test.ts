import { describe, expect, it } from 'vitest';
import {
  deriveFredRateStatus,
  findGappedAccounts,
  findStaleAccounts,
  getProviderHealth,
  isExpectedFeedNotice,
  DEFAULT_HEALTH_OPTIONS,
  RATE_STALE_DAYS,
} from './health';
import { projectNextPayment, reconcileSubscription } from './subscriptions';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));
const NOW = utc(2026, 7, 12);

describe('deriveFredRateStatus — the rate feed judged by its stored observation', () => {
  const observation = (observationDate: string) => ({
    seriesId: 'OBMMIC30YF',
    ratePct: 6.651,
    observationDate,
    fetchedAt: '2026-07-12T04:00:00.000Z',
  });

  it('is silent (null) when nothing was ever stored — the provider is unused', () => {
    expect(deriveFredRateStatus(null, NOW)).toBeNull();
  });

  it('reads OK for a fresh observation, stating the value and its OWN date', () => {
    const s = deriveFredRateStatus({ observation: observation('2026-07-10'), lastError: null }, NOW);
    expect(s?.status).toBe('OK');
    expect(s?.reasons[0]).toBe('All signals normal');
    expect(s?.reasons[1]).toBe('Latest stored: 6.651% observed 2026-07-10');
  });

  it(`warns once the observation date ages past ${RATE_STALE_DAYS} days`, () => {
    // 2026-07-04 is 8 days before NOW (floored from the date, not the fetch).
    const s = deriveFredRateStatus({ observation: observation('2026-07-04'), lastError: null }, NOW);
    expect(s?.status).toBe('WARN');
    expect(s?.reasons[0]).toBe('Stored rate observation is 8 days old (2026-07-04)');
    // A 7-day-old one still passes — a long holiday weekend is not an outage.
    expect(
      deriveFredRateStatus({ observation: observation('2026-07-05'), lastError: null }, NOW)?.status,
    ).toBe('OK');
  });

  it('warns on a recorded fetch failure, keeping the standing observation visible', () => {
    const s = deriveFredRateStatus(
      {
        observation: observation('2026-07-10'),
        lastError: { at: '2026-07-12T04:00:00.000Z', message: 'FRED returned HTTP 400' },
      },
      NOW,
    );
    expect(s?.status).toBe('WARN');
    expect(s?.reasons[0]).toBe('Last rate fetch failed: FRED returned HTTP 400');
    expect(s?.reasons.at(-1)).toBe('Latest stored: 6.651% observed 2026-07-10');
  });

  it('warns when only a failure exists and no observation was ever stored', () => {
    const s = deriveFredRateStatus(
      { observation: null, lastError: { at: '2026-07-12T04:00:00.000Z', message: 'timed out' } },
      NOW,
    );
    expect(s?.status).toBe('WARN');
    expect(s?.reasons).toEqual(['Last rate fetch failed: timed out', 'No rate observation stored yet']);
  });

  it("skips the Setting read entirely under scope: 'accounts' — Overview's round trip stays saved", async () => {
    const prisma = {
      setting: {
        findUnique: () => {
          throw new Error('the FRED Setting must not be read at accounts scope');
        },
      },
      account: { findMany: async () => [] },
      syncLog: { findFirst: async () => null },
    } as unknown as Parameters<typeof getProviderHealth>[0];
    const result = await getProviderHealth(prisma, { ...DEFAULT_HEALTH_OPTIONS, scope: 'accounts' }, NOW);
    expect(result).toEqual([]);
  });
});

describe('findStaleAccounts', () => {
  const account = (id: string, balanceDate: Date) => ({
    id, name: id, type: 'DEPOSITORY', balanceDate, isStale: false,
  });

  it('flags accounts whose balance date fell behind, worst first', () => {
    const result = findStaleAccounts(
      [account('fresh', utc(2026, 7, 11)), account('stale', utc(2026, 6, 20)), account('worse', utc(2026, 5, 1))],
      NOW,
      DEFAULT_HEALTH_OPTIONS.staleBalanceDays,
    );
    expect(result.map((s) => s.accountId)).toEqual(['worse', 'stale']);
    expect(result[1].daysStale).toBe(22);
  });
});

describe('findGappedAccounts', () => {
  const opts = { gapWindowDays: 30, gapMinTypicalPerMonth: 4, gapThresholdRatio: 0.25 };
  const account = { id: 'a1', name: 'Checking', type: 'DEPOSITORY', balanceDate: NOW, isStale: false };

  const steadyHistory = (perMonth: number, months: number) => {
    const txns = [];
    for (let m = 0; m < months; m++) {
      for (let i = 0; i < perMonth; i++) {
        txns.push({ accountId: 'a1', date: utc(2025, 12 + m > 12 ? 12 + m - 12 : 12 + m, 1 + i * 2) });
      }
    }
    return txns;
  };

  it('flags an active account that suddenly went quiet', () => {
    // ~10/month Dec 2025 through May 2026, then nothing in the last 30 days
    const txns = [];
    for (const [y, m] of [[2025, 12], [2026, 1], [2026, 2], [2026, 3], [2026, 4], [2026, 5]] as const) {
      for (let i = 0; i < 10; i++) txns.push({ accountId: 'a1', date: utc(y, m, 1 + i * 2) });
    }
    const result = findGappedAccounts([account], txns, NOW, opts);
    expect(result).toHaveLength(1);
    expect(result[0].recentCount).toBe(0);
    expect(result[0].typicalPerMonth).toBeGreaterThan(8);
  });

  it('stays quiet for accounts with normal recent volume or thin history', () => {
    const txns = [];
    for (const [y, m] of [[2026, 4], [2026, 5], [2026, 6], [2026, 7]] as const) {
      for (let i = 0; i < 10; i++) txns.push({ accountId: 'a1', date: utc(y, m, 1 + i * 2) });
    }
    expect(findGappedAccounts([account], txns, NOW, opts)).toHaveLength(0);

    // Low-activity account (savings): 1 txn/month must never flag
    const sparse = [
      { accountId: 'a1', date: utc(2026, 1, 28) },
      { accountId: 'a1', date: utc(2026, 2, 28) },
      { accountId: 'a1', date: utc(2026, 3, 28) },
    ];
    expect(findGappedAccounts([account], sparse, NOW, opts)).toHaveLength(0);
    void steadyHistory;
  });

  /**
   * Brokerage rows are overwhelmingly dividends, which arrive in quarter-end
   * clusters, so volume is not a liveness signal there. This exact shape — a
   * heavy June and an empty July — flagged a real Fidelity account every
   * off-quarter month. A dead brokerage feed is caught by the stale BALANCE
   * check instead, in five days rather than thirty.
   */
  it('exempts an investment account whose dividends cluster at quarter end', () => {
    // Year-end and Q1 distributions, then a quiet Q2 — the shape that fired.
    const txns = [];
    for (const [y, m] of [[2025, 12], [2026, 3]] as const) {
      for (let i = 0; i < 20; i++) txns.push({ accountId: 'a1', date: utc(y, m, 1 + i) });
    }
    // Same rows, same silence: flagged as a card, ignored as a brokerage.
    expect(findGappedAccounts([{ ...account, type: 'CREDIT' }], txns, NOW, opts)).toHaveLength(1);
    expect(findGappedAccounts([{ ...account, type: 'INVESTMENT' }], txns, NOW, opts)).toHaveLength(0);
  });
});

describe('projectNextPayment', () => {
  it('projects YEARLY from the anchor when no charge exists', () => {
    expect(projectNextPayment(utc(2026, 8, 1), 'YEARLY', null, NOW)).toEqual(utc(2026, 8, 1));
    // Anchor in the past steps forward to the next occurrence
    expect(projectNextPayment(utc(2025, 3, 15), 'YEARLY', null, NOW)).toEqual(utc(2027, 3, 15));
  });

  it('projects from the most recent charge when one exists', () => {
    expect(projectNextPayment(utc(2025, 11, 10), 'MONTHLY', utc(2026, 7, 10), NOW)).toEqual(utc(2026, 8, 10));
  });

  it('handles month-length edges without drifting', () => {
    // Jan 31 + 1 month lands in early March (JS Date semantics), never crashes
    const next = projectNextPayment(utc(2026, 1, 31), 'MONTHLY', null, utc(2026, 2, 1));
    expect(next.getTime()).toBeGreaterThan(utc(2026, 2, 1).getTime());
  });
});

describe('reconcileSubscription', () => {
  const sub = {
    id: 's1', name: 'Netflix', merchantPattern: 'netflix', expectedAmount: 15.99,
    cadence: 'MONTHLY' as const, anchorDate: utc(2025, 11, 10), enabled: true,
  };
  const charge = (id: string, date: Date, amount: number) => ({
    id, date, amount, normalizedMerchant: 'netflix', description: 'NETFLIX.COM',
  });

  it('flags price drift on the first deviating charge', () => {
    const status = reconcileSubscription(
      sub,
      [charge('t1', utc(2026, 6, 10), -15.99), charge('t2', utc(2026, 7, 10), -18.99)],
      NOW,
    );
    expect(status.lastCharge?.amount).toBe(18.99);
    expect(status.priceDrift).toEqual({ expected: 15.99, actual: 18.99, deltaPct: 0.1876 });
    expect(status.nextPaymentDate).toEqual(utc(2026, 8, 10));
    expect(status.daysUntilNextPayment).toBe(29);
  });

  it('reports no drift when the charge matches, and ignores non-matching txns', () => {
    const noise = { id: 'x', date: utc(2026, 7, 1), amount: -50, normalizedMerchant: 'grocery', description: 'FOOD' };
    const status = reconcileSubscription(sub, [charge('t1', utc(2026, 7, 10), -15.99), noise], NOW);
    expect(status.priceDrift).toBeNull();
    expect(status.lastCharge?.transactionId).toBe('t1');
  });

  it('counts down from the anchor when no charge has appeared yet (SimpleFIN yearly case)', () => {
    const simplefin = {
      id: 's2', name: 'SimpleFIN Bridge', merchantPattern: 'simplefin', expectedAmount: 15,
      cadence: 'YEARLY' as const, anchorDate: utc(2026, 8, 1), enabled: true,
    };
    const status = reconcileSubscription(simplefin, [], NOW);
    expect(status.lastCharge).toBeNull();
    expect(status.priceDrift).toBeNull();
    expect(status.nextPaymentDate).toEqual(utc(2026, 8, 1));
    expect(status.daysUntilNextPayment).toBe(20);
  });
});

// Date.UTC NORMALISES an impossible day rather than clamping, so a sub billed
// on the 31st stepped Jan 31 -> "Feb 31" -> Mar 3: February skipped, and the
// anchor drifts further every cycle. Billers clamp; so do we.
describe('projectNextPayment month-end handling', () => {
  it('clamps to the last day of a short month instead of overflowing it', () => {
    const next = projectNextPayment(utc(2026, 1, 31), 'MONTHLY', utc(2026, 1, 31), utc(2026, 2, 15));
    expect(next.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('does not drift the anchor day forward on later cycles', () => {
    const next = projectNextPayment(utc(2026, 1, 31), 'MONTHLY', utc(2026, 1, 31), utc(2026, 3, 15));
    expect(next.toISOString().slice(0, 10)).toBe('2026-03-31');
  });
});

describe('isExpectedFeedNotice', () => {
  // The 90-day cap is how the free tier WORKS and is reported on every sync,
  // so treating it as a warning left the provider amber forever — an
  // indicator that never goes green is one nobody reads. The guard has to
  // stay narrow, though: anything else is still a real signal.
  it('recognises the SimpleFIN date-range cap', () => {
    expect(isExpectedFeedNotice('Requested date range exceeds limit of 90 days and was capped.')).toBe(true);
  });

  it('still warns on everything else the feed reports', () => {
    for (const real of [
      'Account requires reauthentication',
      'Connection to institution failed',
      'Rate limit exceeded',
      'Some accounts could not be refreshed',
    ]) {
      expect(isExpectedFeedNotice(real)).toBe(false);
    }
  });
});
