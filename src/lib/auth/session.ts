// Import from jose's JWS subpaths, not the barrel: the barrel pulls in the JWE
// decompression code (DecompressionStream), which the Edge runtime flags even
// though HS256 sign/verify never touches it.
import { SignJWT } from "jose/jwt/sign";
import { jwtVerify } from "jose/jwt/verify";

/**
 * Stateless signed-cookie session (Session 7). HS256 via `jose`, which runs on
 * Web Crypto — so `verifySessionToken` works in Edge middleware with no DB
 * lookup. The signing secret is `SESSION_SECRET`.
 */
export const SESSION_COOKIE = "fin_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, in seconds
const ALG = "HS256";

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("SESSION_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Non-reversible fingerprint of the CREDENTIAL SET — password hash plus the
 * TOTP secret — embedded in the token and re-checked on every request.
 * Without it, changing your password leaves every existing session valid for
 * its full 30 days — so the natural response to "someone has my password"
 * (run auth:set-password, update the env var) would not actually evict them.
 * The TOTP secret is in the digest for the same reason: rotating it (or
 * ENABLING it — the upgrade moment, when pre-2FA sessions should die) evicts
 * every session that predates it. A digest, not the secrets themselves: JWT
 * payloads are readable by anyone holding the cookie. The `|` separator
 * keeps the two inputs from ever colliding across the boundary.
 */
async function passwordFingerprint(): Promise<string> {
  const hash = process.env.AUTH_PASSWORD_HASH ?? "";
  const totp = process.env.AUTH_TOTP_SECRET ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${hash}|${totp}`));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ role: "owner", pw: await passwordFingerprint() })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: [ALG] });
    return payload.pw === (await passwordFingerprint());
  } catch {
    return false;
  }
}
