import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  totpCode,
  totpCounter,
  verifyTotp,
} from './totp';

/** RFC 6238 Appendix B test secret: ASCII "12345678901234567890". */
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_KEY_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('encodes the RFC secret to the well-known base32 form and decodes it back', () => {
    expect(base32Encode(RFC_KEY)).toBe(RFC_KEY_BASE32);
    expect(base32Decode(RFC_KEY_BASE32)).toEqual(RFC_KEY);
  });

  it('tolerates case, spaces and padding — humans retype these', () => {
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq==')).toEqual(RFC_KEY);
  });

  it('refuses characters outside the alphabet rather than hashing garbage', () => {
    expect(base32Decode('NOT!VALID')).toBeNull();
    expect(base32Decode('')).toBeNull();
  });

  it('generates 32-character secrets (160 bits) that round-trip', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret)!)).toBe(secret);
  });
});

describe('hotp/totp against RFC 6238 Appendix B (SHA-1, 8 digits)', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'], // counter above 2^32 — pins the 8-byte big-endian split
  ];
  for (const [seconds, expected] of vectors) {
    it(`T=${seconds} → ${expected}`, () => {
      expect(hotp(RFC_KEY, totpCounter(seconds * 1000), 8)).toBe(expected);
    });
  }

  it('6-digit codes are the numeric tail of the same truncation', () => {
    expect(totpCode(RFC_KEY_BASE32, totpCounter(59_000))).toBe('287082');
  });
});

describe('verifyTotp', () => {
  const NOW = 1111111111 * 1000; // counter 37037037; codes: 14050471 (0), 07081804 (-1)
  const counterNow = totpCounter(NOW);

  it('accepts the current window and returns its counter', () => {
    expect(verifyTotp(RFC_KEY_BASE32, '050471', NOW, 0)).toBe(counterNow);
  });

  it('accepts the previous window (slow clock) with its own counter', () => {
    expect(verifyTotp(RFC_KEY_BASE32, '081804', NOW, 0)).toBe(counterNow - 1);
  });

  it('rejects a code two windows old — the tolerance is ±1, not a corridor', () => {
    // T=1111111109 - 60s lands two counters back.
    const stale = totpCode(RFC_KEY_BASE32, counterNow - 2)!;
    expect(verifyTotp(RFC_KEY_BASE32, stale, NOW, 0)).toBeNull();
  });

  it('one-use: a counter at or below the replay floor is never accepted again', () => {
    expect(verifyTotp(RFC_KEY_BASE32, '050471', NOW, counterNow)).toBeNull();
    // The NEXT window still works after the floor advances.
    const next = totpCode(RFC_KEY_BASE32, counterNow + 1)!;
    expect(verifyTotp(RFC_KEY_BASE32, next, NOW, counterNow)).toBe(counterNow + 1);
  });

  it('rejects malformed input without throwing: wrong length, letters, empty', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '05047a', '050471 extra']) {
      expect(verifyTotp(RFC_KEY_BASE32, bad, NOW, 0)).toBeNull();
    }
  });

  it('rejects everything under an undecodable secret', () => {
    expect(verifyTotp('NOT!ABASE32SECRET', '050471', NOW, 0)).toBeNull();
  });
});
