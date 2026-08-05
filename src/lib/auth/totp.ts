import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP second factor (RFC 6238 over RFC 4226), hand-rolled on node:crypto.
 *
 * An authenticator app is the ONLY second factor this app can have: SMS,
 * email and push all require a third-party service, and the HARD RULES ban
 * those outright. TOTP is computed offline on both sides from a shared
 * secret — no call leaves either device, which is also why it keeps working
 * during exactly the kind of outage this app plans for.
 *
 * The secret follows the password's pattern exactly: generated locally
 * (`npm run auth:set-totp`), stored ONLY in `AUTH_TOTP_SECRET` wherever this
 * instance reads its environment, never in the database, never committed.
 * Base32 (RFC 4648) because that is what authenticator apps eat — and it is
 * A-Z2-7, so the `$`-mangling and `:`-delimiter lessons of
 * AUTH_PASSWORD_HASH cannot recur here.
 *
 * Node-runtime ONLY (createHmac): imported by the login action and the
 * set-totp script, never by middleware — the Edge session check stays
 * stateless and TOTP is enforced at LOGIN, where the session is issued.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerant of case, spaces and padding — humans retype these. Null on any
 * character outside the alphabet, so a mangled secret fails loudly at
 * verify time rather than quietly hashing garbage. */
export function base32Decode(s: string): Buffer | null {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  if (clean === '') return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, the RFC 4226 recommended size: 32 base32 characters. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** RFC 4226 HOTP: HMAC-SHA1 over the big-endian 8-byte counter, dynamic
 * truncation, modulo 10^digits. SHA-1 is what every authenticator app
 * defaults to; its known weaknesses are collision attacks, which do not
 * apply to HMAC. */
export function hotp(key: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  msg.writeUInt32BE(counter % 0x1_0000_0000, 4);
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpCounter(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpCode(secretBase32: string, counter: number, digits: number = TOTP_DIGITS): string | null {
  const key = base32Decode(secretBase32);
  if (key === null) return null;
  return hotp(key, counter, digits);
}

/**
 * Verify a submitted code against the ±1-step window (90 seconds of clock
 * tolerance) and the REPLAY FLOOR: only counters strictly above
 * `lastAcceptedCounter` are candidates. Returns the accepted counter or
 * null. One-use is a JOINT property: this function only CHECKS the floor —
 * the caller must CLAIM the returned counter with a compare-and-set against
 * the exact floor it read (see the login action), or two concurrent logins
 * can both pass this check on the same code.
 *
 * Comparison is timingSafeEqual per candidate; the loop always tries every
 * candidate so match position does not shape timing.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastAcceptedCounter: number,
): number | null {
  const submitted = code.trim();
  if (!/^\d+$/.test(submitted) || submitted.length !== TOTP_DIGITS) return null;
  const key = base32Decode(secretBase32);
  if (key === null) return null;

  const center = totpCounter(nowMs);
  let accepted: number | null = null;
  for (const counter of [center - 1, center, center + 1]) {
    if (counter <= lastAcceptedCounter) continue;
    const expected = hotp(key, counter);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) {
      accepted = accepted ?? counter;
    }
  }
  return accepted;
}

/** For the enrollment script: what an authenticator app scans or accepts. */
export function otpauthUri(secretBase32: string): string {
  return `otpauth://totp/Ducat?secret=${secretBase32}&issuer=Ducat&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

/**
 * Setting key holding the last ACCEPTED counter — the replay floor. Lives in
 * the database (not env) because it advances on every login; one row, one
 * writer (the login action). In cloud mode that is the cloud database, so
 * the floor is shared by every device that logs in.
 */
export const TOTP_COUNTER_SETTING_KEY = 'auth.totpLastCounter';
