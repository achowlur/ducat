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

/** Whether requests must carry a valid session. */
export function isAuthEnabled(): boolean {
  return isCloudMode() || isAuthConfigured();
}
