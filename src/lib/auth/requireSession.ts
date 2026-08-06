import { cookies } from "next/headers";
import { SESSION_EXPIRED_DIGEST } from "./digests";
import { isAuthEnabled } from "./mode";
import { SESSION_COOKIE, verifySessionToken } from "./session";

/**
 * Defense-in-depth guard for Server Actions (Session 7). Middleware already
 * gates the transport, but Next's guidance is not to rely on middleware alone
 * for authorization — so every mutating action calls this too. No-ops when auth
 * is disabled (local-first), so the localhost UX is untouched.
 *
 * DEFENCE IN DEPTH IS ALL IT IS, and that is worth knowing before relying on
 * this throw for anything user-facing: behind the current middleware it cannot
 * fire. A Server Action POSTs to its page path, middleware matches it, and a
 * request with no valid session is answered 401 before any action code runs
 * (measured 2026-08-06); GETs are redirected to /login for the same reason. The
 * throw is left in place precisely because the middleware matcher could change
 * and Next's own guidance is not to trust the transport gate alone.
 *
 * It carries a DIGEST because a message does not survive a production build —
 * see digests.ts. The boundary keys on that.
 */
export async function requireSession(): Promise<void> {
  if (!isAuthEnabled()) return;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || !(await verifySessionToken(token))) {
    throw Object.assign(new Error("Not authenticated."), { digest: SESSION_EXPIRED_DIGEST });
  }
}
