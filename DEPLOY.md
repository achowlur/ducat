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
turso db show ducat --url        # -> DATABASE_URL: libsql://<db>-<org>.<region>.turso.io
turso db tokens create ducat     # -> TURSO_AUTH_TOKEN
```

On Windows, do both in the dashboard instead: the CLI ships Darwin and Linux
binaries only (checked against its release assets, not just the docs), so token
creation is the second thing it can't do for you.

Take the **database** token, not a **platform/API** token. The platform token
manages your Turso account rather than this database, and using it produces an
opaque auth failure at connect time rather than a useful message. Full
read/write, since the app writes on every sync and categorization, and no
expiry — an expired token also surfaces as confusing runtime errors.

Pick a region close to where Vercel runs your functions, not to you: every
route is server-rendered on demand, so each page view is several round trips
from the function to Turso. Vercel's default is `iad1`, which pairs with
Turso's `aws-us-east-1`.

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

### Already running locally? Copy that database instead

If you have been using Ducat locally, the pack alone understates what the cloud
instance is missing. The feed reaches back 90 days, while a local database holds
however many years of CSV backfill you gave it — and the rules you tuned by hand
sit at priority ≤50, outranking the entire shipped pack. Those live in the
database, not the repo.

```bash
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run turso:copy
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run turso:copy -- --apply
```

Dry run first (it prints row counts per table and the aggregates it will verify),
then `--apply`. It clears the destination and replaces it wholesale, so running
`rules:install` beforehand is harmless but unnecessary. It **refuses a
destination holding any transactions**: this is a one-way copy into a fresh
instance, and two divergent histories of the same accounts cannot be reconciled.

Do this BEFORE the first cloud sync. Once the cloud has synced its own accounts,
the copy has nothing clean to land in and your only options are starting over or
living with the split.

Verification is built in: nine row counts plus eight aggregates — net worth,
summed amounts, MANUAL count, transfer pairs, reimbursements — compared against
the source, and a mismatch exits non-zero telling you not to sync.

## 4 · Generate your secrets (locally, never committed)

```bash
npm run auth:set-password    # type a password (never shown/stored) -> prints AUTH_PASSWORD_HASH + SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # -> CRON_SECRET
```

`CRON_SECRET` is invented here, not looked up anywhere. Vercel attaches it as
`Authorization: Bearer <CRON_SECRET>` when it triggers the cron, and the route
compares it against the same variable — a shared secret whose only job is to
stop anyone who finds the URL from triggering your sync. The command prints the
bare value because its destination is a form field, not a `.env` line.

## 5 · Create the Vercel project and set env vars

Import the repo in Vercel, then set these environment variables (Project →
Settings → Environment Variables). Never put them in a committed file — Vercel
injects them at runtime.

**Paste values only.** Step 4's generators print `.env` lines, not bare values:
`auth:set-password` wraps its output in quotes and the CRON_SECRET one-liner
prints a `CRON_SECRET=` prefix. Include either and it becomes part of the
secret, so login fails and the cron 401s with nothing to indicate why.

**Production only — not Preview.** Preview deployments would share this one
Turso database, so a branch deploy would write to your real data. Left unset
for Preview, a preview build has no `libsql://` URL, so it isn't in cloud mode
and the localhost host-allowlist 403s it. Safe by default.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `libsql://…turso.io` (from step 1) |
| `TURSO_AUTH_TOKEN` | token from step 1 |
| `AUTH_PASSWORD_HASH` | `scrypt:…` from step 4 |
| `SESSION_SECRET` | from step 4 |
| `CRON_SECRET` | from step 4 |
| `SIMPLEFIN_ACCESS_URL` | your SimpleFIN access URL |
| `NEXT_TELEMETRY_DISABLED` | `1` |
| `DUCAT_TIMEZONE` | your zone, e.g. `America/New_York` |

Not `TZ` — **Vercel rejects it as a reserved name** ("The name of your
Environment Variable is reserved"), which is why the app reads `DUCAT_TIMEZONE`
first. `TZ` still works anywhere that allows it, including locally, where you
can leave both unset and get your machine's zone.

This only affects how wall-clock instants are *displayed*: "synced Jul 25, 1:04
PM EDT" rather than `17:04`. Without it Vercel runs functions in UTC and every
sync time reads four or five hours off, with no label to say so. Transaction
dates stay pinned to UTC in code and are deliberately unaffected — the feed
mixes noon UTC, midnight Eastern and true instants, so re-zoning a date would
move correct ones — and all period math uses `Date.UTC`, so no month boundary
moves either.

Auth **fails closed**: a `libsql://` deployment without `AUTH_PASSWORD_HASH` +
`SESSION_SECRET` refuses to serve rather than run open.

Set these BEFORE the first deploy, or redeploy after adding them — Vercel
applies env-var changes to new deployments, not running ones. Note that a
successful build proves nothing here: no route is prerendered, so the build
never reads the database or the auth vars. Only the running app does.

While you're in Settings → Functions, check the region matches the one you gave
Turso in step 1 (`iad1` pairs with `aws-us-east-1`). Every page view is several
function → database round trips, so a mismatch is felt on every screen.

## 6 · Deploy

```bash
vercel          # link the project (first time)
vercel --prod   # production deploy
```

The build runs `prisma generate` (via `postinstall`) then `next build`. The
generated Prisma client is gitignored, so this step is what creates it on Vercel.

## 7 · Verify the deployment

- **Auth:** open the URL → you should hit the login screen. Enter your password.
- **Cron:** Vercel → Project → Cron Jobs lists `/api/cron/sync` (daily 23:00 UTC).
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

## Living with two copies

Once the cloud instance is real, decide which one you write to — and write to
only that one. The transaction data is self-healing either way (dedupe is
`(accountId, externalId)`, and `externalId` is the feed's own id, so the same
transaction lands identically in both), but everything you do BY HAND drifts:
rules you create, MANUAL categorizations, insight dismissals. Those are the
valuable part, and nothing reconciles them.

Cloud is the natural primary — it has the cron and it's the one on your phone.
So stop syncing locally, and leave the local database frozen as a realistic
development fixture.

### Back the cloud up

```bash
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run cloud:backup
```

Writes a dated file under `data/backups/` (gitignored) and verifies it against
the cloud with the same row counts and aggregates `turso:copy` uses. Never
overwrites an earlier one.

Do this even though Turso takes its own backups. Free-plan point-in-time
recovery reaches back **24 hours** — 10 days on Developer, 30 on Scaler, 90 on
Pro — which covers "I just deleted the wrong thing" and nothing else. The
failures this app has actually had were silent wrong numbers found days later.
A local file is also a different failure domain: an account problem, a revoked
token or a lapsed plan doesn't reach your disk.

A backup is an ordinary Ducat database, so you can open one directly:

```bash
DATABASE_URL="file:./data/backups/ducat-2026-07-26-2145.db" npm run dev
```

### When the schema changes

`prisma migrate deploy` can't target libSQL, and the cloud database has no
`_prisma_migrations` table, so a new migration doesn't reach it on its own.
Generate the delta against the deployed schema and apply it the same way
`turso:push` applies the baseline. Worth doing calmly the first time rather
than while something is broken.

## Revoke / roll back

- Rotate `SESSION_SECRET` → invalidates all existing sessions immediately.
- `turso db tokens revoke …` → cut off database access.
- Revoke the SimpleFIN access URL at the bridge → stops all feed access.
- Delete the Vercel project and/or `turso db destroy ducat` → the data is gone.

## Going back to local

Nothing here touches local mode. Run the app with a `file:` `DATABASE_URL` and no
auth vars, and it's the private, loopback-only, no-login app again.
