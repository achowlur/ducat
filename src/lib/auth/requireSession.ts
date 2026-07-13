import { cookies } from "next/headers";
import { isAuthEnabled } from "./mode";
import { SESSION_COOKIE, verifySessionToken } from "./session";

/**
 * Defense-in-depth guard for Server Actions (Session 7). Middleware already
 * gates the transport, but Next's guidance is not to rely on middleware alone
 * for authorization — so every mutating action calls this too. No-ops when auth
 * is disabled (local-first), so the localhost UX is untouched.
 */
export async function requireSession(): Promise<void> {
  if (!isAuthEnabled()) return;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || !(await verifySessionToken(token))) {
    throw new Error("Not authenticated.");
  }
}
