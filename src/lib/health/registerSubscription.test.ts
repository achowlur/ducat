import { describe, expect, it } from 'vitest';
import { draftSubscription } from './registerSubscription';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

function input(over: Partial<Parameters<typeof draftSubscription>[0]> = {}) {
  return {
    normalizedMerchant: 'link.com',
    description: 'LINK.COM 8004791222 CA',
    amount: -1.5,
    date: utc(2026, 7, 25),
    cadence: 'MONTHLY' as const,
    ...over,
  };
}

describe('draftSubscription', () => {
  it('derives everything but the cadence from the transaction', () => {
    const d = draftSubscription(input());
    expect(d).not.toBeNull();
    expect(d?.name).toBe('link.com');
    expect(d?.merchantPattern).toBe('link.com');
    expect(d?.expectedAmount).toBe(1.5);
    expect(d?.cadence).toBe('MONTHLY');
    expect(d?.anchorDate).toEqual(utc(2026, 7, 25));
  });

  it('keeps punctuation, because the matcher is a literal substring', () => {
    // Regression: routing this through payeeKey turned "link.com" into
    // "link com", which appears nowhere in its own source, so the tracked
    // subscription would never have matched a single charge.
    const d = draftSubscription(input());
    expect('link.com').toContain(d?.merchantPattern ?? 'x');
  });

  it('truncates at a billing reference that changes every cycle', () => {
    const source = 'verizon paymentrec urring 1001 marlowe brennan';
    const d = draftSubscription(input({ normalizedMerchant: source }));
    expect(d?.merchantPattern).toBe('verizon paymentrec urring');
    // The invariant that matters: still a literal substring of its own source,
    // so it matches the charge it came from AND the next one, whose reference
    // will differ.
    expect(source).toContain(d?.merchantPattern ?? 'x');
  });

  it('leaves padded whitespace alone, since neither side is collapsed at match time', () => {
    const source = 'zelle to  recipient';
    const d = draftSubscription(input({ normalizedMerchant: source }));
    expect(source).toContain(d?.merchantPattern ?? 'x');
  });

  it('falls back to the description when there is no merchant', () => {
    const d = draftSubscription(input({ normalizedMerchant: '', description: 'ACME WIDGETS CO' }));
    expect(d?.merchantPattern).toBe('acme widgets co');
    expect(d?.name).toBe('ACME WIDGETS CO');
  });

  it('refuses a pattern too short to match safely', () => {
    // The same floor the grouped review enforces: a substring match on "o"
    // would sweep up costco, doordash and every Zelle.
    expect(draftSubscription(input({ normalizedMerchant: 'o', description: 'o' }))).toBeNull();
  });

  it('refuses an inflow — a subscription is something you are billed for', () => {
    expect(draftSubscription(input({ amount: 140 }))).toBeNull();
    expect(draftSubscription(input({ amount: 0 }))).toBeNull();
  });

  it('rounds the expected amount to cents', () => {
    expect(draftSubscription(input({ amount: -14.9899 }))?.expectedAmount).toBe(14.99);
  });

  it('carries the cadence through unchanged, since it is the one thing a charge cannot tell you', () => {
    expect(draftSubscription(input({ cadence: 'YEARLY' }))?.cadence).toBe('YEARLY');
  });
});
