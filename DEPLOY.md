# Deploying to your own cloud (optional)

Ducat runs fine entirely on your machine — that's the private default,
and nothing below is required for local use. This guide is for the **optional**
single-tenant cloud deployment (Turso + Vercel) so you can reach your instance
from anywhere with a daily auto-sync.

## Read this first — what changes in cloud mode

The charter is *"local-first by default; optional self-hosted cloud with auth +
encryption; no third party ever custodies your data as a shared service."* You
deploy **your own** instance — the maintainer hosts nothing and can't see your
data. But be clear-eyed about the trade-off:

- Your data now lives in **Turso** (the database) and runs on **Vercel** (the
  server). Turso encrypts at rest, but it can read your data while serving
  queries. The app's `connect-src 'self'` CSP only constrains the *browser* — it
  can't (and shouldn't) stop the *server → Turso* connection.
- This is **not** end-to-end encryption. "We can't read it even if breached"
  (client-side keys, analyzers in the browser) is deliberately deferred.
- If that trade-off isn't acceptable, **stay in local mode** — it's unchanged.

## Prerequisites

- A [Turso](https://turso.tech) account + the `turso` CLI (`turso auth login`).
- A [Vercel](https://vercel.com) account + the `vercel` CLI (`vercel login`), or the dashboard.
- Your SimpleFIN access URL (`npm run simplefin:claim -- <setup-token>`), or plan to use CSV.
- Node 20+ and this repo cloned locally.

> These steps create accounts, log in, and enter secrets — do them yourself. The
> repo is built and verified deploy-ready, but provisioning is yours to run.

## 1 · Create the Turso database

```bash
turso db create finance
turso db show finance --url        # -> your DATABASE_URL (libsql://<db>-<org>.turso.io)
turso db tokens create finance     # -> your TURSO_AUTH_TOKEN
```

Encryption at rest is on by default. For bring-your-own-key encryption, see
Turso's [encryption docs](https://docs.turso.tech/tursodb/encryption).

## 2 · Apply the schema

Generate the full schema as one SQL script and pipe it into the remote DB
(libSQL is HTTP-based, so `prisma migrate deploy` can't target it directly):

```bash
npm run turso:baseline > baseline.sql
turso db shell finance < baseline.sql
rm baseline.sql
```

## 3 · Generate your secrets (locally, never committed)

```bash
npm run auth:set-password    # type a password (never shown/stored) -> prints AUTH_PASSWORD_HASH + SESSION_SECRET
node -e "console.log('CRON_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

## 4 · Create the Vercel project and set env vars

Import the repo in Vercel, then set these **Production** environment variables
(Project → Settings → Environment Variables). Never put them in a committed file
— Vercel injects them at runtime.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `libsql://…turso.io` (from step 1) |
| `TURSO_AUTH_TOKEN` | token from step 1 |
| `AUTH_PASSWORD_HASH` | `scrypt:…` from step 3 |
| `SESSION_SECRET` | from step 3 |
| `CRON_SECRET` | from step 3 |
| `SIMPLEFIN_ACCESS_URL` | your SimpleFIN access URL |
| `NEXT_TELEMETRY_DISABLED` | `1` |

Auth **fails closed**: a `libsql://` deployment without `AUTH_PASSWORD_HASH` +
`SESSION_SECRET` refuses to serve rather than run open.

## 5 · Deploy

```bash
vercel          # link the project (first time)
vercel --prod   # production deploy
```

The build runs `prisma generate` (via `postinstall`) then `next build`. The
generated Prisma client is gitignored, so this step is what creates it on Vercel.

## 6 · Verify the deployment

- **Auth:** open the URL → you should hit the login screen. Enter your password.
- **Cron:** Vercel → Project → Cron Jobs lists `/api/cron/sync` (daily 08:00 UTC).
  Trigger it manually, or:
  ```bash
  curl -H "Authorization: Bearer <CRON_SECRET>" https://<your-deployment>.vercel.app/api/cron/sync
  ```
  A wrong/absent token returns 401; a correct one returns a JSON sync summary.
- **Headers:**
  ```bash
  curl -sI https://<your-deployment>.vercel.app/ | grep -iE 'content-security-policy|strict-transport-security'
  ```
  You should see the CSP and `Strict-Transport-Security` (HSTS is production-only).

## Revoke / roll back

- Rotate `SESSION_SECRET` → invalidates all existing sessions immediately.
- `turso db tokens revoke …` → cut off database access.
- Revoke the SimpleFIN access URL at the bridge → stops all feed access.
- Delete the Vercel project and/or `turso db destroy finance` → the data is gone.

## Going back to local

Nothing here touches local mode. Run the app with a `file:` `DATABASE_URL` and no
auth vars, and it's the private, loopback-only, no-login app again.
