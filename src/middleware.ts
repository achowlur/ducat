import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAuthConfigured, isAuthEnabled, isCloudMode } from "./lib/auth/mode";
import { demoMisconfiguration } from "./lib/demo/mode";
import { SESSION_COOKIE, verifySessionToken } from "./lib/auth/session";

/**
 * Request gate (Session 6 host-allowlist + Session 7 auth). Runs on the Edge
 * runtime, so it only does stateless work: env checks and a jose cookie verify
 * (no DB, no Node crypto).
 *
 *   1. Local mode: reject any non-loopback Host (anti-DNS-rebinding). Skipped in
 *      cloud mode, where the app is served from a real hostname.
 *   2. `/api/cron/*` authorizes itself with CRON_SECRET → bypasses the session gate.
 *   3. When auth is enabled, require a valid signed session cookie. Cloud mode
 *      deployed without auth configured fails closed (never serves open).
 */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostnameOnly(host: string | null): string | null {
  if (host === null || host === "") return null;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

function textResponse(message: string, status: number): NextResponse {
  // charset declared: every one of these messages carries an em dash, and
  // without it browsers decode UTF-8 as Latin-1 and print "â€”".
  return new NextResponse(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

// Pass the resolved path to the layout (via a request header it can't spoof —
// we overwrite it) so it can hide the app chrome on /login.
//
// The QUERY travels separately rather than widening x-app-path, because the
// layout compares that header with `=== "/login"` and /login is reached as
// /login?error=1. The database-unavailable notice needs the whole thing: its
// "Try again" is the one control whose job is to re-ask the SAME question, and
// four of the six pages it can appear on keep their entire view state in the
// query (page, period, category, group, payee queue).
function passthrough(request: NextRequest, pathname: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set("x-app-path", pathname);
  headers.set("x-app-query", request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const cloud = isCloudMode();

  // 1. Anti-DNS-rebinding — local mode only.
  if (!cloud) {
    const host = hostnameOnly(request.headers.get("host"));
    if (host === null || !ALLOWED_HOSTS.has(host)) {
      return textResponse("Forbidden — this app serves localhost only.", 403);
    }
  }

  // 1b. A public demo holding a real bank feed serves NOTHING — cron included,
  // so it cannot sync either. Checked on every request rather than once at
  // boot, so a variable added later is caught on the next request.
  const demoProblem = demoMisconfiguration();
  if (demoProblem !== null) {
    return textResponse(demoProblem, 503);
  }

  // 2. Cron endpoints self-authorize with CRON_SECRET.
  if (pathname.startsWith("/api/cron/")) {
    return passthrough(request, pathname);
  }

  // 3. Auth gate.
  if (isAuthEnabled()) {
    if (!isAuthConfigured()) {
      return textResponse(
        "Auth is not configured. Set AUTH_PASSWORD_HASH and SESSION_SECRET, then redeploy.",
        503,
      );
    }
    const onLogin = pathname === "/login";
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const valid = token !== undefined && (await verifySessionToken(token));

    if (!valid && !onLogin) {
      // Server Actions POST to page paths — reject rather than bounce.
      if (request.method !== "GET" && request.method !== "HEAD") {
        return textResponse("Unauthorized.", 401);
      }
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      return NextResponse.redirect(url);
    }
    if (valid && onLogin) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return passthrough(request, pathname);
}

// Guard pages, RSC, and Server Actions. Static chunks/images under _next carry
// no user data, so they're skipped to keep asset serving and HMR light.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
