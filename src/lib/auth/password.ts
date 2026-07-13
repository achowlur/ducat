import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt (Node built-in — no native/bcrypt dependency,
 * so it installs cleanly on serverless). Stored form: `scrypt:<saltHex>:<hashHex>`.
 * Node-runtime only (not Edge): used by the login route and the set-password
 * script, never in middleware.
 *
 * The delimiter is `:`, NOT `$`: Next.js's .env loader expands `$name` as a
 * variable reference, which silently mangles a `$`-delimited hash down to
 * "scrypt" in a local .env. `:` is safe (salt/hash are hex) and never expanded.
 */
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length);
  // timingSafeEqual requires equal lengths; the length check guards it.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
