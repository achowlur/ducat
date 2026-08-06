/**
 * Error digests, in their own module because BOTH sides need them and the two
 * sides have incompatible dependencies: `requireSession` imports next/headers
 * (server only), `app/error.tsx` is "use client". A shared constant is the only
 * way the thrower and the boundary cannot drift apart into two string literals.
 *
 * WHY A DIGEST AND NOT THE MESSAGE. In production Next never sends a server
 * error's message to the client — `create-error-handler` hashes it into a
 * digest and the flight client rebuilds a fresh Error reading "The specific
 * message is omitted in production builds…". So any boundary branch keyed on
 * `error.message` is dead on the deployment while passing in dev, which is
 * exactly what happened here. The digest is the one field that survives, and
 * Next preserves one we set ourselves — its own source says so: "the error
 * already has a digest, respect the original digest, so it won't get
 * re-generated into another new error" (`if (!err.digest)`).
 */
export const SESSION_EXPIRED_DIGEST = "DUCAT_SESSION_EXPIRED";
