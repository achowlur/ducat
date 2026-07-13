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

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ role: "owner" })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, secretKey(), { algorithms: [ALG] });
    return true;
  } catch {
    return false;
  }
}
