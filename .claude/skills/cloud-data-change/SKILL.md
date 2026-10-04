---
name: cloud-data-change
description: Anything that writes rows or schema to a Ducat database, or reads real figures from one. Covers npm run upgrade, schema:push, goals, readiness, accounts:cash, rules:install, repair:*, import:csv and import:balances backfills, db:seed and db:reset, and checking balances, totals or counts. Steps are which database, simulating the blast radius on a backup copy first, the operator-run cloud command, reading the label line, and verifying on the deployment.
---

# Change data on a Ducat database

Read `.claude/rules/sync-and-data-ops.md` first.

## Which database

- TWO DATABASES. Code ships with git push; DATA does not. The CLOUD is the
  only writer. Local `data/ducat.db` is a nightly MIRROR, never written by
  hand: a local write makes the mirror refuse.
- The repo's `.env` holds NO Turso credentials, by design. Cloud writes are
  run BY THE OPERATOR with credentials they hold. Hand them the command;
  never ask for the token.
- Figures (balances, totals, counts) are read on the deployment. Localhost
  proves structure and behaviour, not figures. The mirror is built from the
  newest verified BACKUP, not the live cloud: compare
  `data/backups/mirror-state.json`'s source date with the last cloud data
  change, and if the cloud is newer, preview on a scratch copy with that
  change applied.

## Before anything that rewrites existing rows

1. **Simulate it.** Copy the newest canonical backup
   (`data/backups/ducat-YYYY-MM-DD-HHMM.db`; never a `.partial` or
   `.unverified`) to a scratch path and run the change there through the real
   code path: `applyRules`, the `reapplyRules` diff, or the command itself
   with `DATABASE_URL=file:<scratch copy>`. Open SQLite `readonly` for
   anything that only reads. A local throwaway `scripts/tmp-*.ts` (gitignored)
   is the usual harness. Never simulate on `data/ducat.db`.
2. **Report the blast radius** (rows changed, from → to by category and flow,
   totals moved, for each order the commands could run in), then WAIT for
   the operator's go-ahead.
3. **Before deleting a surface,** check what the CLOUD has that reaches it.
   The two databases differ in which rows exist.
4. **A CSV backfill:** `npm run import:csv -- --dry-run` per file. Before the
   first real import, also import against a copy of a verified backup and
   compare `npm run db:fingerprint` digests. Read docs/csv-import.md and the
   deeper-history entry in docs/backlog.md (`--until` is also the balance
   guard).

## The cloud command

- Hand it over as a Windows PowerShell 5.1 block that starts with
  `cd <repo root>` (a fresh window, or a `file:` URL resolves elsewhere and
  SQLite silently creates an empty database). Set the variables on their own
  lines (`$env:DATABASE_URL = "libsql://…"`, `$env:TURSO_AUTH_TOKEN = "…"`),
  with no `&&` and no bash `VAR=x cmd` prefix. A bare run reads `.env` and
  hits LOCAL, and it can report "nothing to do" because local already had
  the change.
- Ask for the FIRST line of output: it must read `CLOUD —` and the turso
  host. Anything else did not touch the cloud.
- After a release, the order is `schema:push` (only ever ADDS; one refusal
  blocks the run; read its script before running any of it), then `upgrade`
  (regenerates insights, reapplies rules and the closed box), then any Setting
  writer (`goals`, `readiness`, `accounts:cash`).
- `npm run goals --add` is NOT idempotent: read the printed listing before
  adding. `db:seed` and `db:reset` DESTROY everything: never on the cloud.

## After

- Verify on `<your-deployment>.vercel.app` in the in-app browser: read back
  the figures the change should have moved.
- If only the pages that read a NEW column 500, the schema push missed the
  cloud.
- After a schema change, restart the local dev server (PrismaClient
  singleton).
- Local catches up at the nightly mirror, or sooner with `npm run db:mirror`.
  A local that was written refuses; only `db:mirror --confirm` replaces it,
  keeping the old file.
