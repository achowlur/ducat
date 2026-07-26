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

- A [Turso](https://turso.tech) account. The `turso` CLI is optional — it has no
  native Windows build, and `npm run turso:push` replaces the one step that
  needed it.
- A [Vercel](https://vercel.com) account. The `vercel` CLI is optional too; a
  dashboard Git import deploys on push.
- Your SimpleFIN access URL (`npm run simplefin:claim -- <setup-token>`), or plan to use CSV.
- Node 20+ and this repo cloned locally.

> These steps create accounts, log in, and enter secrets — do them yourself. The
> repo is built and verified deploy-ready, but provisioning is yours to run.

## 1 · Create the Turso database

```bash
turso db create ducat
turso db show ducat --url        # -> your DATABASE_URL (libsql://<db>-<org>.turso.io)
turso db tokens create ducat     # -> your TURSO_AUTH_TOKEN
```

Encryption at rest is on by default. For bring-your-own-key encryption, see
Turso's [encryption docs](https://docs.turso.tech/tursodb/encryption).

## 2 · Apply the schema

libSQL is HTTP-based, so `prisma migrate deploy` can't target it directly. Use
the pusher, which needs no CLI — handy, because the Turso CLI has no native
Windows build (its documented install is WSL-only):

```bash
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run turso:push
```

Expect `Created 9 tables and 2 indexes`. It **refuses a database that already
has tables**: a baseline is not idempotent, so a second run would fail every
`CREATE TABLE` and leave a half-applied schema. That guard is also what stops a
mistyped `DATABASE_URL` from being pointed at your own local data.

Set the variables inline rather than editing `.env`, or the next local command
silently runs against the cloud. In PowerShell, use `$env:DATABASE_URL="…"` in
a throwaway terminal you then close.

<details>
<summary>Equivalent with the Turso CLI, if you have it</summary>

```bash
npm run --silent turso:baseline > baseline.sql
head -1 baseline.sql   # must be "-- CreateTable", not npm's "> ducat@…" banner
turso db shell ducat < baseline.sql
rm baseline.sql
```

`--silent` is load-bearing: without it npm writes its own `> ducat@0.1.0
turso:baseline` banner into the file and `turso db shell` stops at
`near ">": syntax error` having created nothing.
</details>

Either route generates the schema from `prisma/schema.prisma` rather than
replaying `prisma/migrations/`, so it is current by construction — verified to
produce a schema identical to applying every migration in order.

Note for later: the cloud database gets no `_prisma_migrations` table, and
`prisma migrate deploy` can't reach it, so a *future* schema change means
generating just the delta and applying it the same way. Nothing reads that
table at runtime, so this only matters when you next change the schema.

## 3 · Seed the starter categorization pack

The baseline creates tables, not rows. Without this the cloud instance has zero
categories, so everything that syncs lands uncategorized and the grouped review
is the only way out.

Every CLI script picks its database from `DATABASE_URL` alone (see
`src/lib/prisma.ts` — one libSQL adapter serves both schemes), so point the two
Turso variables at it for one command:

```bash
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run rules:install
```

Expect `Categories created: 15`, `Rules created: 421`,
`Transactions recategorized: 0`. Setting the variables inline is deliberate:
they take precedence over `.env` for that one process and leave your local
database alone — don't edit `.env`, or the next local command silently runs
against the cloud. In PowerShell, inline prefixes don't work; use
`$env:DATABASE_URL="…"` in a throwaway terminal you then close.

The same trick runs any other script against the cloud database —
`sync:simplefin`, `import:csv`, `insights:generate`.

## 4 · Generate your secrets (locally, never committed)

```bash
npm run auth:set-password    # type a password (never shown/stored) -> prints AUTH_PASSWORD_HASH + SESSION_SECRET
node -e "console.log('CRON_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

## 5 · Create the Vercel project and set env vars

Import the repo in Vercel, then set these **Production** environment variables
(Project → Settings → Environment Variables). Never put them in a committed file
— Vercel injects them at runtime.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `libsql://…turso.io` (from step 1) |
| `TURSO_AUTH_TOKEN` | token from step 1 |
| `AUTH_PASSWORD_HASH` | `scrypt:…` from step 4 |
| `SESSION_SECRET` | from step 4 |
| `CRON_SECRET` | from step 4 |
| `SIMPLEFIN_ACCESS_URL` | your SimpleFIN access URL |
| `NEXT_TELEMETRY_DISABLED` | `1` |

Auth **fails closed**: a `libsql://` deployment without `AUTH_PASSWORD_HASH` +
`SESSION_SECRET` refuses to serve rather than run open.

## 6 · Deploy

```bash
vercel          # link the project (first time)
vercel --prod   # production deploy
```

The build runs `prisma generate` (via `postinstall`) then `next build`. The
generated Prisma client is gitignored, so this step is what creates it on Vercel.

## 7 · Verify the deployment

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
- Delete the Vercel project and/or `turso db destroy ducat` → the data is gone.

## Going back to local

Nothing here touches local mode. Run the app with a `file:` `DATABASE_URL` and no
auth vars, and it's the private, loopback-only, no-login app again.
