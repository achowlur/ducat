import type { NextConfig } from "next";

/**
 * Security headers (Session 6 hardening). The charter's core promise —
 * "no transaction data ever leaves this machine" — was previously enforced
 * only by developer discipline. The CSP below makes it a browser-enforced
 * boundary: `connect-src 'self'` blocks every fetch/XHR/WebSocket/beacon to
 * any off-origin host, and `default-src 'self'` blocks loading any external
 * resource. Even a supply-chain-compromised dependency running in the page
 * cannot exfiltrate data or phone home.
 *
 * `'unsafe-inline'` (script/style) is required for the pre-paint theme script
 * in layout.tsx and Next's own inline bootstrap; it does NOT weaken the
 * exfiltration guarantee, which rests on connect-src/default-src. Dev adds
 * `'unsafe-eval'` (HMR/React Refresh) and the same-origin HMR websocket.
 */
const isDev = process.env.NODE_ENV !== "production";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  `connect-src 'self'${isDev ? " ws://127.0.0.1:* ws://localhost:*" : ""}`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
];

const nextConfig: NextConfig = {
  // Don't advertise the framework/version to any client.
  poweredByHeader: false,
  // Native module (better-sqlite3) and the generated Prisma client must not
  // be bundled by webpack — load them from node_modules at runtime.
  serverExternalPackages: ["better-sqlite3", "@prisma/adapter-better-sqlite3"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
