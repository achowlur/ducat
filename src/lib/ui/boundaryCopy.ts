/**
 * What the error boundary says, as a pure function so it can be tested.
 *
 * It lives outside app/error.tsx because Next type-checks that file's exports
 * against a fixed set, and because a client component that imports next/link
 * is awkward to render in the suite. Same split as DatabaseUnavailable, and for
 * the same reason: the wording IS the deliverable here, so it has to be
 * assertable.
 *
 * The rewrite (2026-08-06) came out of finding the "Session expired" branch
 * dead in production twice over — see docs/conventions/security-and-auth.md.
 * What changed in substance:
 *
 *  - "Your data is unchanged" is GONE from the generic state. A Server Action
 *    can throw after a partial write and the boundary cannot know which
 *    happened, so that was a reassurance the evidence could not support. It
 *    survives ONLY in the expired state, where it is true: `requireSession()`
 *    is the first statement in every action, so nothing ran.
 *  - "retrying is safe" is GONE too. For the case this screen actually shows
 *    most — a lapsed session, which middleware answers 401 before any action
 *    code runs — retrying fails identically, so it was advice that could not
 *    work. "Reload to see the current state" is true either way.
 *  - The sign-in route is offered only when a gate EXISTS. Telling a local-mode
 *    reader with no password configured to sign in is nonsense, and /login
 *    redirects straight back to / for them.
 */
export interface BoundaryCopy {
  heading: string;
  body: string;
  /** Offer the route to /login. */
  signIn: boolean;
  /** Offer reset() — pointless once we know the session is the problem. */
  retry: boolean;
}

export function boundaryCopy({ expired, gated }: { expired: boolean; gated: boolean }): BoundaryCopy {
  if (expired) {
    return {
      heading: "Session expired",
      body: "Your session is no longer valid. Sign in again to continue — nothing was lost, because the check runs before the action does anything.",
      signIn: true,
      retry: false,
    };
  }

  return {
    heading: "Something went wrong",
    body: gated
      ? "That action didn't complete. Reload to see the current state — and if it keeps failing, a lapsed sign-in looks exactly like this."
      : "That action didn't complete. Reload to see the current state.",
    signIn: gated,
    retry: true,
  };
}
