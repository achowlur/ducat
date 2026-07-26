"use client";

import Link from "next/link";

/**
 * Without a boundary, any thrown Server Action drops the whole app to Next's
 * bare error screen. The likeliest cause is mundane: a tab left open past the
 * 30-day session, where requireSession() throws on the next click. Middleware
 * only redirects navigations, never action responses, so the user would just
 * see everything vanish with no way back.
 */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  const expired = /not authenticated/i.test(error.message);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center gap-3">
      <h1 className="text-[0.8rem] font-semibold uppercase tracking-[0.14em]">
        {expired ? "Session expired" : "Something went wrong"}
      </h1>
      <p className="text-[0.85rem] text-faint">
        {expired
          ? "Your session is no longer valid. Sign in again to continue — nothing was lost."
          : "That action didn't complete. Your data is unchanged; retrying is safe."}
      </p>
      <div className="flex gap-2">
        <button
          onClick={reset}
          className="rounded border-2 border-ink px-3 py-1.5 text-[0.78rem] uppercase tracking-[0.08em] hover:bg-chip"
        >
          Try again
        </button>
        <Link
          href={expired ? "/login" : "/"}
          className="rounded border-2 border-rule px-3 py-1.5 text-[0.78rem] uppercase tracking-[0.08em] text-faint hover:border-ink hover:text-ink"
        >
          {expired ? "Sign in" : "Back to overview"}
        </Link>
      </div>
    </div>
  );
}
