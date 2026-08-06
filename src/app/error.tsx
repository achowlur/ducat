"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SESSION_EXPIRED_DIGEST } from "../lib/auth/digests";
import { boundaryCopy } from "../lib/ui/boundaryCopy";

/**
 * Without a boundary, any thrown Server Action drops the whole app to Next's
 * bare error screen. Middleware only redirects navigations, never action
 * responses, so the user would just see everything vanish with no way back.
 * (Page RENDERS that fail because the database is unreachable no longer arrive
 * here — they render a named state instead; see components/DatabaseNotice.tsx.)
 *
 * IT KEYS ON `digest`, NEVER ON `error.message`. The message is replaced by a
 * fixed sentence in production builds, so the previous `/not authenticated/i`
 * test passed in dev and was dead on the deployment — the one place the failure
 * it existed for actually happens. digests.ts carries the reasoning.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const expired = error.digest === SESSION_EXPIRED_DIGEST;

  // Whether a password gate exists at all, published by the layout onto <html>
  // the way the theme is. Read in an effect rather than during render: this
  // component can be rendered on the server for a failed SSR pass, where there
  // is no document, and a value that differed between the two would be a
  // hydration mismatch — the failure mode this app has already paid for once.
  const [gated, setGated] = useState(false);
  useEffect(() => {
    setGated(document.documentElement.dataset.auth === "on");
  }, []);

  const copy = boundaryCopy({ expired, gated });

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-3">
      <h1 className="text-[0.8rem] font-semibold uppercase tracking-[0.14em]">{copy.heading}</h1>
      <p className="text-[0.85rem] text-faint">{copy.body}</p>
      <div className="flex flex-wrap gap-2">
        {copy.retry && (
          <button
            onClick={reset}
            className="tap44 rounded border-2 border-ink px-3 py-1.5 text-[0.78rem] uppercase tracking-[0.08em] hover:bg-chip"
          >
            Try again
          </button>
        )}
        {copy.signIn && (
          <Link
            href="/login"
            className="tap44 inline-flex items-center rounded border-2 border-ink px-3 py-1.5 text-[0.78rem] uppercase tracking-[0.08em] hover:bg-chip"
          >
            Sign in
          </Link>
        )}
        <Link
          href="/"
          className="tap44 inline-flex items-center rounded border-2 border-rule px-3 py-1.5 text-[0.78rem] uppercase tracking-[0.08em] text-faint hover:border-ink hover:text-ink"
        >
          Back to overview
        </Link>
      </div>
    </div>
  );
}
