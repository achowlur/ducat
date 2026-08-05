# Ducat — security & auth conventions

Moved VERBATIM from CLAUDE.md on 2026-08-01 (the split). This file holds the
full evidence — what each rule cost and why alternatives failed. The one-line
enforceable rules live in CLAUDE.md and point here. Additions follow the same
contract: rule line in CLAUDE.md, evidence here, never both in one place.

- `AUTH_PASSWORD_HASH` uses a `:` delimiter, NOT `$`. Next's `.env` loader
  expands `$name` and silently mangles a `$`-delimited hash down to "scrypt", so
  the gate stays up (non-empty) while every login fails. This cost a debugging
  session and appears nowhere else in the repo.
- Auth fails CLOSED on partial configuration. Setting EITHER
  `AUTH_PASSWORD_HASH` or `SESSION_SECRET` counts as intent to lock, and
  middleware turns intent-without-completion into a 503. Requiring both would
  fail OPEN on the likeliest mistake — pasting the hash into `.env` while
  leaving `SESSION_SECRET=""` from `.env.example` — serving everything with no
  login while the operator believes a gate is up.
- Session tokens carry a non-reversible DIGEST of the password hash, re-checked
  per request, so changing the password evicts existing sessions. Without it the
  natural response to "someone has my password" left every session valid for its
  full 30 days. A digest, not the hash — JWT payloads are readable by whoever
  holds the cookie.
- Middleware redirects NAVIGATIONS only, never Server Action responses. A tab
  left open past its session throws instead of redirecting, which is why an
  error boundary exists — without one the whole app drops to Next's bare error
  screen.
- The dev CSP needs `'unsafe-eval'` and a same-origin HMR websocket for Fast
  Refresh. Don't remove them while "tightening" `next.config.ts` — production
  gets neither.
- THE SECOND FACTOR IS TOTP, AND THE CHOICE WAS FORCED (built 2026-08-04).
  SMS, email and push each require a third-party service, and the HARD RULES
  ban those calls outright — so an authenticator app, computed offline on
  both sides of a shared secret, is the only second factor this app can
  have. Implemented on node:crypto in ~60 lines (src/lib/auth/totp.ts),
  pinned against every RFC 6238 Appendix B vector including the one above
  2^32 that catches a bad 8-byte counter split; no new dependency.
  The secret follows the password's pattern EXACTLY: generated locally by
  npm run auth:set-totp, stored only in AUTH_TOTP_SECRET, never in the
  database, never committed. Base32 (A-Z2-7) is immune to both recorded env
  hazards — no `$` to expand, no delimiter at all. The set-totp script
  VERIFIES one code against the fresh secret before printing the env line,
  because the failure it prevents — a mistyped secret discovered at the next
  login, from outside — is a lockout on the operator's own gate.
  Codes are ONE-USE, and one-use is a JOINT property that the first draft
  got half of: verifyTotp CHECKS counters against the stored floor (Setting
  auth.totpLastCounter), and the login action must CLAIM the accepted
  counter by compare-and-set against the exact value it read — updateMany
  keyed on (key AND old value), create for the missing row, and a lost
  claim IS a failed login. The draft's plain upsert was read-check-write,
  and the adversarial review proved the window real: two logins presenting
  the SAME code concurrently both pass the check before either writes (both
  sit in ~100ms scrypt verifies first), so a real-time relay of a
  shoulder-surfed code landed a second session — and two DIFFERENT
  concurrently-accepted codes could even move the floor BACKWARD, re-arming
  spent codes. With the CAS, exactly one concurrent claimant wins. Window
  is ±1 step (90s of clock tolerance); every candidate is compared with
  timingSafeEqual and the loop never exits early. Login therefore depends
  on the database — acceptable because every page after login does too.
  ORDERING AND ERRORS are part of the design: the password (scrypt) is
  checked FIRST so TOTP guessing costs an scrypt verify per attempt, and
  both factors fail into ONE generic message — which factor failed is
  exactly what an attacker holding half the credentials wants to know. Both
  factors submit in a single form: no half-authenticated server state, no
  second step to time out.
  EVICTION ON ENABLE: the session token's fingerprint digests
  AUTH_PASSWORD_HASH + '|' + AUTH_TOTP_SECRET, so enabling OR rotating the
  second factor invalidates every existing session — the moment 2FA turns
  on is precisely the moment sessions issued without it must die (pinned in
  auth.test.ts). AUTH_TOTP_SECRET alone also counts as INTENT to lock in
  isAuthEnabled(), so a TOTP secret on an otherwise-unconfigured instance
  503s rather than serving open.
  SCOPE, stated honestly on /providers: the factor protects LOGIN only — a
  stolen session cookie is valid until expiry; middleware stays a stateless
  Edge cookie check and never sees TOTP. The trust page's perimeter line is
  CONDITIONAL on isTotpConfigured(): "no second factor" over an instance
  that has one is the reassuring lie's mirror image. NO IN-APP RECOVERY,
  deliberately: losing the authenticator is solved by removing the env var
  and redeploying — an in-app reset would be a second factor only against
  attackers who don't attack the app.
