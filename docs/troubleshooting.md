# Troubleshooting

Symptom first; each of these has cost someone real time.

## Login always fails, though the gate is clearly up

If `AUTH_PASSWORD_HASH` contains `$`, Next's `.env` loader treats `$name` as a
variable reference and silently mangles the value — the gate stays up (the
variable is non-empty) while every login fails. Ducat's own hash format uses
`:` as the delimiter for exactly this reason. Generate the value with
`npm run auth:set-password` and paste it unmodified; don't hand-roll a
`$`-delimited scrypt/bcrypt string.

## Every page says "no data" right after seeding

`npm run db:seed` builds insights itself, so this means it stopped before
finishing — read its output for the error. Pages render from stored insights,
so after fixing the cause either re-seed or run:

```bash
npm run insights:generate
```

A seed run on the first of a month shortly after midnight UTC shows that month
as "nothing recorded yet": the demo's data ends at its newest nightly sync,
which is still the previous day. It fills in after 23:16 UTC, or view the
prior month.

## Dev server: "Cannot find module './NNN.js'", or buttons stop responding

`npm run build` was run while the dev server was up. Both share `.next/`, and
the build corrupts the dev server's chunks — the page may still render while
every client-side handler is silently dead. Fix: stop the dev server, delete
the `.next/` directory, restart. Avoid running builds while dev is up.

## PrismaClientValidationError ("Unknown field") after a migration — locally

The dev server's Prisma client survives hot reload with the old generated
code, so it doesn't know the column you just added. Restart the dev server.

## PrismaClientValidationError on the cloud deployment after upgrading

Different cause, same error: the deploy shipped code that reads a new column,
but `prisma migrate deploy` cannot reach a Turso database, so the column never
arrived — and the build stays green because it never opens the database. Run:

```bash
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run schema:push
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run schema:push -- --apply
```

See [lifecycle.md](lifecycle.md) — schema is the third thing that upgrades
separately.

## `turso db shell` fails with `near ">": syntax error` on the baseline

The baseline file starts with npm's own banner (`> ducat@0.1.0 …`) instead of
SQL. Regenerate it with `--silent`:

```bash
npm run --silent turso:baseline > baseline.sql
head -1 baseline.sql   # must be "-- CreateTable"
```

Or skip the Turso CLI entirely: `npm run turso:push` applies the baseline
without it (the CLI has no native Windows build anyway).

## Login fails on Vercel with nothing on screen to say why; the cron 401s

The env-var values were pasted with decoration included.
`npm run auth:set-password` prints ready-to-paste `.env` **lines** —
`AUTH_PASSWORD_HASH="…"`, quotes and all — but Vercel's form wants **bare
values**: no surrounding quotes, no `NAME=` prefix. Anything extra becomes
part of the secret, so login fails and the cron 401s with no visible cause.

## A sync reports "0 imported" but the app looks stale

"0 imported" doesn't say *which* database is up to date. The shell may still
be holding the cloud `DATABASE_URL` from an earlier command, so the "local"
sync ran against Turso. Every syncing/writing script prints the database it's
touching as its first line — check it, then re-run in a clean terminal.

## A rule/goal/setting change works locally but the deployment ignores it

It was run against one database. Data does not travel with `git push`; run
the same command against the cloud database too, and verify on the deployed
app. See [lifecycle.md](lifecycle.md).
