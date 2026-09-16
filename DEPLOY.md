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
`prisma migrate deploy` can't reach it, so a *future* schema change goes through
`npm run schema:push` instead — see [When the schema changes](#when-the-schema-changes).
Nothing reads that table at runtime, so its absence only matters in that it
rules out the usual migration path.

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

**Paste values only.** `auth:set-password` prints `.env` lines with the values
wrapped in quotes — include the quotes and they become part of the secret, so
login fails with nothing to indicate why. The CRON_SECRET one-liner prints the
bare hex value and is safe to paste as-is.

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
| `AUTH_TOTP_SECRET` | *optional* — base32 secret from `npm run auth:set-totp` (second factor) |
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

### Optional: a second factor (authenticator app)

```bash
npm run auth:set-totp
```

The script generates a TOTP secret, has you add it to your authenticator app
(any of them — SHA-1, 6 digits, 30 seconds is every app's default), and
**verifies one code before printing the env line**, so a mistyped secret is
caught at enrollment rather than at tomorrow's locked-out login. Set the
printed `AUTH_TOTP_SECRET` in the environment and redeploy; the login form
then requires password **and** code, submitted together.

An authenticator app is the only second factor this app will ever offer: SMS,
email and push all require a third-party service, which the HARD RULES ban.
Codes are **one-use** (the accepted counter is stored in the database and
claimed by compare-and-set, so a phished code dies the moment the real login
lands — even if both arrive at once). Enabling or rotating the secret **logs
out every existing session** — deliberate: the moment you add a second factor
is exactly the moment pre-2FA sessions should die. What it does NOT cover: a
stolen session cookie is valid until it expires — the factor protects login,
not the transport. Recovery is operating your own infrastructure: lose the
authenticator, remove `AUTH_TOTP_SECRET` from the environment and redeploy.
There is no in-app reset, deliberately.

**Remembered devices.** The login form offers "remember this device for 90
days" (ticked by default) whenever it asks for a code. Tick it and that
browser gets a separate signed cookie; later logins on it need the **password
alone**. Untick it on anything borrowed. The trade-offs, stated plainly:

- The device cookie **waives the code, it does not grant access** — stolen
  without your password it is worth nothing, and presenting it as a session
  cookie fails (each token names its own type; a test pins this).
- A remembered device is therefore **only as protected as your password**,
  for 90 days. That is the convenience you are buying.
- Remembering is earned by a code **in that same login**, never inherited, so
  one enrollment cannot renew itself forever.
- To un-remember everything, rotate `SESSION_SECRET` or `AUTH_TOTP_SECRET` —
  every device is asked for a code again (and every session ends).

An IP allowlist was considered instead and **rejected**: phones sit behind
carrier-grade NAT, so the address rotates and is shared with strangers, home
IPs are dynamic, and any allowlisted network trusts every other device on it.
Device identity is the thing worth trusting; network location is not.

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

## Upgrading to a newer version

`git push` deploys the code. It does **not** touch your data, and a newer
version can ship categorization rules your database has never seen — the app
keeps using the old set, the deploy is green, and the only symptom is
transactions landing in the wrong category. The same is true of the analyzers:
insights are computed once and STORED, so a version that changed how a number
is calculated leaves the old number on the page until the rows are regenerated.
So after pulling a new version, run this once **per database**:

```bash
npm run upgrade
```

It installs any pack rules that are missing — and regenerates the monthly
insight rows every time, missing rules or not, which is what covers the
analyzer half above. It is idempotent, creates only what is absent, and never
edits a rule you have changed yourself — a hand-tuned rule at priority ≤50
still outranks the whole pack. `npm run upgrade -- --check` reports the rule
gap without writing; a real run always writes the insight rows.

For the cloud instance, point the two Turso variables at it for that one
command, in a throwaway terminal you then close:

```bash
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run upgrade
```

Overview's **Needs review** panel counts the missing RULES and names this
command whenever a database is behind on them — but that is the only half it
can see. Nothing on any page can tell you the stored insights were computed by
older analyzer code, so a silent panel is not a reason to skip this after a
`git pull`.

What this does **not** cover is a schema change — that is the other command,
[`npm run schema:push`](#when-the-schema-changes). Run both after a version that
changes the schema: `schema:push` gives the database the new columns, `upgrade`
gives it the new rules.

## Living with two copies

Once the cloud instance is real, decide which one you write to — and write to
only that one. The transaction data is self-healing either way (dedupe is
`(accountId, externalId)`, and `externalId` is the feed's own id, so the same
transaction lands identically in both), but everything you do BY HAND drifts:
rules you create, MANUAL categorizations, insight dismissals. Those are the
valuable part, and nothing reconciles them.

Cloud is the natural primary — it has the cron and it's the one on your phone.
So stop syncing locally: never point `sync:simplefin` or a CSV import at the
local database once the cloud is real, because two independent writers is
exactly how the hand-made work diverges.

Local is not frozen, though — it is a MIRROR. Make every data change on the
cloud; the nightly scheduled backup copies it down to local after verifying it
(see below), and `npm run db:mirror` does the same on demand. One writer, one
direction, and the two agree. A local
database that has silently drifted is worse than no local database: it is a
development fixture that no longer reproduces the bug you are chasing, and it
is the thing you would restore from on the day you need it most.

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

### Scheduled local backups (Windows)

The manual command works until the day it can't: on 2026-08-04 Turso's
us-east-1 router returned 502 to every query for over two hours, and
`cloud:backup` cannot run against an unreachable database — the one moment you
want a backup is the one moment you cannot take one. The scheduled form takes
one every night while everything is healthy, so an outage always finds a
recent copy already on your disk.

**Set up once:**

1. Create `.env.backup` in the repo root — gitignored (the `.env*` rule),
   never committed — holding exactly two lines:

   ```
   DATABASE_URL="libsql://<db>-<org>.<region>.turso.io"
   TURSO_AUTH_TOKEN="<database token>"
   ```

   The wrapper reads this file **exclusively** — never `.env` (which points at
   the local database) and never the shell environment — so a terminal still
   holding cloud variables cannot redirect it, and the Task Scheduler's bare
   session behaves identically to a hand run.

2. Prove it end to end by hand before scheduling anything:

   ```bash
   npm run backup:scheduled -- --dry-run
   npm run backup:scheduled
   ```

   `--dry-run` takes and fingerprint-verifies a real backup but only *reports*
   what pruning and the Setting write would do.

3. Register the scheduled task from an **elevated** PowerShell (Run as
   administrator) — registering an S4U task from a normal shell fails with
   `Access is denied`, measured here, even for your own account. The XML form
   is used because it pins the trigger to **UTC** (the `Z` suffix — Task
   Scheduler's "synchronize across time zones"), which a plain
   `New-ScheduledTaskTrigger` cannot express:

   ```powershell
   Register-ScheduledTask -TaskName "Ducat nightly backup" -Xml (Get-Content "<repo>\scripts\backup-task.xml" -Raw)
   ```

   (The repo does not ship `backup-task.xml` because it embeds absolute
   machine paths; generate it from the template below or ask the assistant
   session that registers it to write one.) The template:

   ```xml
   <?xml version="1.0" encoding="UTF-16"?>
   <Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
     <RegistrationInfo>
       <Description>Ducat: nightly verified local backup of the cloud database. 23:50 UTC — after the 23:00 sync cron plus Vercel Hobby's 8-43 min lateness; backing up earlier captures yesterday.</Description>
     </RegistrationInfo>
     <Triggers>
       <CalendarTrigger>
         <StartBoundary>2026-08-04T23:50:00Z</StartBoundary>
         <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
         <Enabled>true</Enabled>
       </CalendarTrigger>
     </Triggers>
     <Principals>
       <Principal id="Author">
         <UserId>YOUR-PC\you</UserId>
         <LogonType>S4U</LogonType>
         <RunLevel>LeastPrivilege</RunLevel>
       </Principal>
     </Principals>
     <Settings>
       <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
       <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
       <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
       <StartWhenAvailable>true</StartWhenAvailable>
       <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
       <Enabled>true</Enabled>
     </Settings>
     <Actions Context="Author">
       <Exec>
         <Command>C:\path\to\repo\scripts\backup-scheduled.cmd</Command>
         <WorkingDirectory>C:\path\to\repo</WorkingDirectory>
       </Exec>
     </Actions>
   </Task>
   ```

   Two choices in there are the point. `LogonType S4U` is "run whether user is
   logged on or not" without a stored password — the task runs in session 0,
   so **no console window ever appears** while you're using the machine.
   `StartWhenAvailable` means a machine that was asleep at 23:50 UTC runs the
   backup on wake: late is always safe — only *early* (before the sync cron)
   captures yesterday.

4. Confirm it fires without waiting a day:

   ```powershell
   Start-ScheduledTask -TaskName "Ducat nightly backup"
   Get-ScheduledTaskInfo -TaskName "Ducat nightly backup" | Select LastRunTime, LastTaskResult
   ```

   `LastTaskResult` 0 is success; then read the tail of
   `data\backups\backup.log`, which every run appends to.

**What a run does, in order — each step gates the next:**

1. Copies every table to a new dated file under `data/backups/` — on a
   `.partial` name, because the canonical `ducat-….db` name is **earned by
   verification** — and runs the same nine row counts + eight aggregates
   `cloud:backup` checks.
2. Content-fingerprints the **cloud** and the **file** (`db:fingerprint`'s
   whole-database digest) and compares. Counts are blind to a changed
   category or a flipped `dismissed`; the digest is not. On a match the file
   takes its canonical name. A mismatch — usually a write landing mid-copy —
   fails the run and **quarantines** the file as `.unverified`: inspectable,
   but invisible to retention, so a bad file can never later be elected a
   month's keeper while proven backups are deleted around it.
3. Prunes retention: every file on the 14 most recent distinct backup dates
   stays, plus the newest file of each older month. Only exact
   `ducat-YYYY-MM-DD-HHMM.db` names are candidates; `backup.log`, `.partial`,
   `.unverified` and anything hand-renamed are never touched. Pruning never
   runs on a failed backup.
4. **Mirrors local**: `data/ducat.db` becomes a copy of the verified file —
   its rows replaced in one transaction and proved equal to the backup before
   it commits, so local keeps its schema and migration history and a failure
   leaves it exactly as it was. It happens only while local still matches the
   digests recorded after its last mirror (`data/backups/mirror-state.json`);
   if anything wrote to local since, the mirror refuses rather than lose that
   work. It also refuses until it has been started once with
   `npm run db:mirror -- --confirm`, and it fails (rolled back) when the two
   schemas differ — apply a schema change to both databases.
5. Writes the `backup.lastRun` Setting — `{at, file, wholeDigest, rows,
   localMirror}` — to the **cloud first**, then, only after a successful
   mirror, to local, and records local's new state for the next night. A
   refused or failed mirror leaves local completely untouched. A failed
   backup writes no Setting.

**The signal:** `/providers` ("This instance") shows *"Last local backup: N
days ago"* with the verified row count and digest, read from that Setting —
which is why it works on the phone, where `data/backups/` does not exist. It
escalates like balance staleness: WARN on the second silent night, ERROR past
a week. The line appears after the first verified run and never disappears —
a backup job that dies quietly is worse than none. It also says whether local
was updated to match, and WARNs — even on a fresh backup — when it was not,
with the reason: a local app quietly reading stale figures is the failure the
mirror exists to prevent.

### Bring local back into line with the cloud

The nightly scheduled backup keeps local current by itself. To start it, or
to bring local current before tonight, mirror from the newest verified backup:

```bash
npm run db:mirror              # report only: both digests, and whether local changed since its last mirror
npm run db:mirror -- --confirm # replace local's rows with the backup's
```

It needs no credentials and no network: the backup has already been proved
equal to the cloud, so copying from it cannot be caught out by a sync landing
mid-transfer. With `--confirm` it first keeps the current local database as
`data/ducat-superseded-YYYY-MM-DD-HHMM.db`, which nothing ever deletes, then
replaces every row in one transaction and proves the result equal to the
backup before committing. `-- --from=data/backups/ducat-….db` picks an older
verified backup; `.partial` and `.unverified` files are refused.

Read the report before confirming. If it says local HAS CHANGED since its last
mirror, that work exists only on this machine and replacing local loses it —
redo it on the cloud first. After a confirmed run the nightly job carries on
from the recorded state.

Mirror AFTER the nightly cron, not before: `0 23 * * *` UTC, and Vercel Hobby
fires 8-43 minutes late, so a backup taken earlier in the day permanently
captures yesterday. The scheduled task runs at 23:50 UTC for that reason.

A backup is an ordinary Ducat database, so you can open one directly:

```bash
DATABASE_URL="file:./data/backups/ducat-2026-07-26-2145.db" npm run dev
```

### When the schema changes

`prisma migrate deploy` can't target libSQL, and the cloud database has no
`_prisma_migrations` table, so a new migration doesn't reach it on its own. A
green deploy tells you nothing either way — the build never opens the database.
The first symptom is a `PrismaClientValidationError` on whichever page reads the
new field.

```bash
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run schema:push
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run schema:push -- --apply
```

Dry run first, like `turso:copy`. It compares `prisma/schema.prisma` against
what that database actually has and prints two lists: what it **will apply**,
and what it **cannot**. Nothing is written without `--apply`, and it is safe to
run twice — apply it, run it again, and it reports nothing to do.

It only ever adds. SQLite can create a table, add a column and create an index;
it has no `ALTER COLUMN` and no way to drop a constraint, so **a dropped column,
a changed type, a changed nullability, an added or removed foreign key, and
anything that might be a rename are all refused**, with the row count at stake
printed beside each. One refusal blocks the whole run, including the additive
part — a half-applied schema is harder to reason about than one nothing has
touched.

Two things worth knowing before you meet them:

- **Whether a column can be added depends on whether that table is empty.**
  SQLite takes a `NOT NULL` column with no default, or one defaulting to
  `CURRENT_TIMESTAMP` (which is what `@default(now())` compiles to), only into a
  table with no rows. So the same command can apply cleanly against your local
  database and refuse against the cloud, and it is right both times — it reports
  the state of the database in front of it.
- **A refusal is not a dead end.** Prisma will write the rebuild for you if you
  point it at a *copy* of the database rather than at Turso:

  ```bash
  npm run cloud:backup
  DATABASE_URL="file:./data/backups/<file>" npx prisma migrate diff \
      --from-config-datasource --to-schema prisma/schema.prisma --script
  ```

  Note `--from-config-datasource`, not `--from-url`: that flag was removed in
  Prisma 7, and its replacement takes the URL from `prisma.config.ts`, i.e. from
  `DATABASE_URL`. The script it prints contains the twelve-step table rebuilds —
  and it *drops* what `schema:push` refuses to drop, rows and all, so read it
  before running any of it.

An empty database is sent back to `turso:push` instead: a baseline is one
statement per table and applies in one go, where a column-by-column delta
against nothing is just a slower way to reach the same place.

Worth doing calmly the first time rather than while something is broken.

## Revoke / roll back

- Rotate `SESSION_SECRET` → invalidates all existing sessions immediately.
- `turso db tokens revoke …` → cut off database access.
- Revoke the SimpleFIN access URL at the bridge → stops all feed access.
- Delete the Vercel project and/or `turso db destroy ducat` → the data is gone.

## Going back to local

Nothing here touches local mode. Run the app with a `file:` `DATABASE_URL` and no
auth vars, and it's the private, loopback-only, no-login app again.
