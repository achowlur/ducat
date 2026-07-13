import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Anti-DNS-rebinding host allowlist (Session 6 hardening).
 *
 * The server binds to 127.0.0.1, so no network peer can reach it — but a
 * browser can. A malicious web page can rebind its own domain to 127.0.0.1
 * (DNS rebinding) and issue requests that arrive here carrying the attacker's
 * Host header, letting a remote site read this machine's financial data.
 * Rejecting any request whose Host isn't loopback closes that path.
 *
 * (State-changing Server Actions are already covered by Next's built-in Origin
 * check; this additionally protects reads — pages and RSC payloads.)
 */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostnameOnly(host: string | null): string | null {
  if (host === null || host === "") return null;
  // IPv6 literals are bracketed, e.g. "[::1]:3000".
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

export function middleware(request: NextRequest): NextResponse {
  const host = hostnameOnly(request.headers.get("host"));
  if (host === null || !ALLOWED_HOSTS.has(host)) {
    return new NextResponse("Forbidden — this app serves localhost only.", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }
  return NextResponse.next();
}

// Guard pages, RSC, and Server Actions. Static chunks/images under _next carry
// no user data, so they're skipped to keep asset serving and HMR light.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
