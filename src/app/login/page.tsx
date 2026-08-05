import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isAuthEnabled, isTotpConfigured } from "../../lib/auth/mode";
import { DEVICE_COOKIE, verifyDeviceToken } from "../../lib/auth/session";
import { login } from "./actions";

/**
 * Single-user unlock screen. Only reachable when the auth gate is on; locally
 * (gate off) it redirects home. Styling uses the same ledger tokens as the app
 * and stays within the Session 6 CSP (`form-action 'self'`, no external assets).
 *
 * The authenticator-code field exists only when AUTH_TOTP_SECRET is set —
 * both factors submit together in one form, so there is no half-logged-in
 * state to hold server-side, and one generic error covers both factors (which
 * one failed is exactly what half a credential set wants to know).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!isAuthEnabled()) redirect("/");
  const { error } = await searchParams;
  // What this decides is only what the FORM SHOWS. The action re-checks the
  // device cookie itself before waiving anything, so a doctored form cannot
  // talk its way past the second factor.
  const deviceToken = (await cookies()).get(DEVICE_COOKIE)?.value;
  const remembered = deviceToken !== undefined && (await verifyDeviceToken(deviceToken));
  const totp = isTotpConfigured() && !remembered;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center">
      <h1 className="text-[0.8rem] font-semibold uppercase tracking-[0.14em]">Ducat</h1>
      <p className="mt-1 text-[0.8rem] text-faint">
        This instance is locked. Enter your password{totp ? " and authenticator code" : ""} to continue.
      </p>
      <form action={login} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-[0.75rem] uppercase tracking-[0.1em] text-faint">
          Password
          <input
            type="password"
            name="password"
            autoFocus
            required
            autoComplete="current-password"
            className="rounded border-2 border-rule bg-transparent px-3 py-2 font-money text-base text-ink outline-none focus:border-acc"
          />
        </label>
        {totp && (
          <>
            <label className="flex flex-col gap-1 text-[0.75rem] uppercase tracking-[0.1em] text-faint">
              Authenticator code
              <input
                type="text"
                name="code"
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                className="rounded border-2 border-rule bg-transparent px-3 py-2 font-money text-base tracking-[0.3em] text-ink outline-none focus:border-acc"
              />
            </label>
            {/* Ticked by default: on a single-user instance the device in
                your hand is almost always yours. Untick it on anything
                borrowed — that is the whole point of it being a choice. */}
            <label className="tap44 flex items-center gap-2 text-[0.78rem] text-faint">
              <input type="checkbox" name="remember" defaultChecked className="h-4 w-4 accent-acc" />
              Remember this device for 90 days
            </label>
          </>
        )}
        {remembered && (
          <p className="text-[0.75rem] text-faint">
            This device is remembered, so no code is needed. Rotating your password or
            authenticator secret asks every device for a code again.
          </p>
        )}
        {error !== undefined ? (
          <p className="text-[0.8rem] text-neg">{totp ? "Incorrect password or code." : "Incorrect password."}</p>
        ) : null}
        <button
          type="submit"
          className="mt-1 rounded border-2 border-ink bg-ink px-3 py-2 text-[0.8rem] font-semibold uppercase tracking-[0.1em] text-paper"
        >
          Unlock
        </button>
      </form>
    </div>
  );
}
