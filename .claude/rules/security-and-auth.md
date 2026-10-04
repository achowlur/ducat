---
paths:
  - "src/middleware.ts"
  - "src/lib/auth/**"
  - "src/lib/demo/**"
  - "src/app/login/**"
  - "src/app/error.tsx"
  - "src/app/**/actions.ts"
  - "src/app/api/**"
  - "src/app/providers/**"
  - "next.config.ts"
  - "package.json"
  - "vercel.json"
  - "scripts/{set-password,set-totp}.ts"
---

# Rules: security & auth

Evidence: docs/conventions/security-and-auth.md. Read it before changing
anything below. The auth gate itself is a HARD RULE (CLAUDE.md).

- AUTH_PASSWORD_HASH uses a `:` delimiter, never `$` — Next's env loader
  silently mangles `$`.
- Auth fails CLOSED on partial configuration: either variable set counts as
  intent to lock; middleware 503s on intent-without-completion.
- Session tokens carry a DIGEST of the password hash, re-checked per
  request, so a password change evicts sessions.
- Middleware redirects navigations only — the error boundary exists for
  Server Action responses; keep it.
- The error boundary branches on `error.digest` set at the THROW, never on
  `error.message` — production replaces the message, so a message test passes
  in dev and is dead on the deployment; and it claims nothing about what a
  failed action wrote.
- A server action REFUSES by returning `{ ok: false, message }`
  (lib/actionResult.ts), never by throwing: production replaces a thrown
  message, so the reason never reaches the control. Only the unexpected
  throws, to the boundary.
- The dev CSP needs 'unsafe-eval' and the HMR websocket; production gets
  neither — don't "tighten" them away.
- The second factor is TOTP via AUTH_TOTP_SECRET, opt-in and env-only:
  verified at LOGIN in the Node action (never middleware), password checked
  FIRST, codes ONE-USE via the auth.totpLastCounter Setting floor CLAIMED by
  compare-and-set (a lost claim is a failed login — plain upsert raced), and
  the session fingerprint digests BOTH secrets — enabling or rotating either
  evicts every session. ONE generic login error, never which factor failed.
- Never propose SMS, email, or push as a factor — each requires a third-party
  call the HARD RULES ban, and never an IP allowlist (CGNAT rotates and is
  shared; a network is not a device). /providers' perimeter line states which
  factors are configured and must keep matching isTotpConfigured().
- A remembered device (fin_device, 90d) waives the CODE, never the password:
  it grants nothing alone, is EARNED by a code in that same request, and
  every token names its own typ — both cookies share a signing key, so
  without that claim a device cookie IS a session cookie. Rotation
  un-remembers everything; the login PAGE only picks the form, the ACTION
  re-checks the cookie.
- The PUBLIC DEMO is DUCAT_DEMO_PASSWORD, nothing else: the login gate stays
  configured and is never bypassed (its password is printed on the login
  page), the cron RESEEDS instead of syncing, and a demo holding a SimpleFIN
  URL 503s EVERY request in middleware. It owns its own Turso database.
- package.json `allowScripts` approves install scripts by NAME, never
  pkg@version. A NEW entry still needs a reason in its PR.
