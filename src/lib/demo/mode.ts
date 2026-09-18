/**
 * The public demo is an ordinary instance with one extra variable:
 * DUCAT_DEMO_PASSWORD, the password its login page PRINTS. Its presence is
 * what makes an instance the demo, so no demo behaviour can be switched on by
 * accident elsewhere — and none of it touches the auth code: the demo sets the
 * normal AUTH_PASSWORD_HASH and SESSION_SECRET, and this only publishes the
 * password those already check.
 *
 * Demo mode: the login page shows the password and says the data is invented,
 * and the nightly cron RESEEDS instead of syncing (src/lib/demo/reseed.ts).
 * A demo that also holds a SimpleFIN access URL is refused outright: it would
 * pull a real person's bank data into an instance whose password is public.
 */
export function demoPassword(): string | null {
  const value = process.env.DUCAT_DEMO_PASSWORD ?? '';
  return value === '' ? null : value;
}

export function isDemo(): boolean {
  return demoPassword() !== null;
}

/** Why this instance must not serve, or null when it may. */
export function demoMisconfiguration(): string | null {
  if (isDemo() && (process.env.SIMPLEFIN_ACCESS_URL ?? '') !== '') {
    return 'This is a public demo (DUCAT_DEMO_PASSWORD is set) and it holds a SimpleFIN access URL. A demo must never reach a real bank feed — remove SIMPLEFIN_ACCESS_URL, then redeploy.';
  }
  return null;
}
