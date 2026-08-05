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

/**
 * Remembered-device cookie: proof that THIS browser once passed the second
 * factor, so later logins need the password alone. It is deliberately NOT a
 * credential — it waives the TOTP step and grants nothing by itself, so
 * stolen without the password it is worthless. Ninety days because it is a
 * device fact, not a session.
 */
export const DEVICE_COOKIE = "fin_device";
export const DEVICE_MAX_AGE = 60 * 60 * 24 * 90;

/**
 * Both cookies are signed with the SAME key, so each token names its own
 * type and every verifier demands it. Without this a device cookie —
 * carrying an identical `pw` claim — could simply be pasted into the
 * session cookie and would verify, turning the weaker "no code needed"
 * token into full access with no password. The claim is what keeps the
 * device token strictly weaker than the session token.
 */
const TYP_SESSION = "session";
const TYP_DEVICE = "device";

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
  return new SignJWT({ role: "owner", typ: TYP_SESSION, pw: await passwordFingerprint() })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: [ALG] });
    return payload.typ === TYP_SESSION && payload.pw === (await passwordFingerprint());
  } catch {
    return false;
  }
}

/**
 * Issued only after a login that actually presented a valid TOTP code, and
 * only when the operator ticked "remember this device" — enrollment is the
 * moment the second factor was satisfied, never inherited from a previous
 * remembered login.
 */
export async function createDeviceToken(): Promise<string> {
  return new SignJWT({ typ: TYP_DEVICE, pw: await passwordFingerprint() })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${DEVICE_MAX_AGE}s`)
    .sign(secretKey());
}

/**
 * True when this browser may skip the code. Carries the same credential
 * fingerprint as a session, so rotating EITHER secret — or enabling,
 * disabling or rotating the second factor — makes every remembered device
 * present a code again. That is also the way to un-remember a device you
 * should not have: rotate, and they all re-verify.
 */
export async function verifyDeviceToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: [ALG] });
    return payload.typ === TYP_DEVICE && payload.pw === (await passwordFingerprint());
  } catch {
    return false;
  }
}
