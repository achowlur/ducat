/**
 * Auth mode detection (Session 7). Pure `process.env` reads only — safe to
 * import from Edge middleware.
 *
 * - Local-first (default): `DATABASE_URL=file:…`, no auth configured → the gate
 *   is OFF, so the localhost UX is unchanged.
 * - Cloud (`DATABASE_URL=libsql://…`): the gate is REQUIRED. If the operator
 *   deployed without configuring auth, the app fails closed (never serves open).
 * - Local + auth configured: the user opted into a password gate locally.
 */
export function isCloudMode(): boolean {
  return (process.env.DATABASE_URL ?? "").startsWith("libsql://");
}

export function isAuthConfigured(): boolean {
  return Boolean(process.env.AUTH_PASSWORD_HASH) && Boolean(process.env.SESSION_SECRET);
}

/**
 * Whether requests must carry a valid session.
 *
 * Setting EITHER secret counts as intent to lock the app. Requiring both would
 * fail OPEN on the likeliest mistake — pasting AUTH_PASSWORD_HASH into .env but
 * leaving SESSION_SECRET="" from .env.example — which serves everything with no
 * login and no warning, while the operator believes a gate is up. Middleware
 * turns intent-without-completion into a loud 503, as cloud mode already did.
 */
export function isAuthEnabled(): boolean {
  return (
    isCloudMode() ||
    Boolean(process.env.AUTH_PASSWORD_HASH) ||
    Boolean(process.env.SESSION_SECRET)
  );
}
