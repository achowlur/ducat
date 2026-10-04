---
name: backup-mirror
description: Ducat's nightly backup and local mirror. backup:scheduled, cloud:backup, db:mirror, db:fingerprint, retention, the .env.backup file, the Windows scheduled task, and reading a /providers backup-age or mirror-refusal warning. Use when a backup or mirror failed, is late, or is being changed, or when proving two databases equal.
---

# Backups and the local mirror

Read `.claude/rules/sync-and-data-ops.md` first (its "Backups and the mirror"
rules), then the SCHEDULED LOCAL BACKUPS, LOCAL IS MIRRORED NIGHTLY and
BACKUP SLOT MOVED PAST THE CRON HOUR entries in
docs/conventions/sync-and-data-ops.md before changing any of it.

## What runs, and when

- The Windows scheduled task fires `backup:scheduled` at 00:30 UTC, AFTER
  the whole `0 23 * * *` sync-cron hour (Vercel Hobby fires anywhere in the
  hour, never early). Backing up before the sync permanently captures
  yesterday.
- The run copies the cloud onto a `.partial` file, verifies whole-database
  fingerprints against the cloud, renames to the canonical
  `ducat-YYYY-MM-DD-HHMM.db`, mirrors local ROWS from it in one transaction,
  and only then writes `backup.lastRun` (cloud first, then local). A failure
  quarantines the copy as `.unverified`, writes no row, and deletes nothing.
- The wrapper reads `.env.backup` only, never `.env` or the shell.

## A warning on /providers

1. **Backup age.** Nights since the last PROVEN copy. Look for `.unverified`
   files and the task's last result. Run `npm run backup:scheduled` by hand
   once the sync has landed; it is safe late and only wrong EARLY. A manual
   `cloud:backup` never updates the age.
2. **Mirror refused.** Local no longer matches the digests recorded after the
   last mirror (`data/backups/mirror-state.json`), so something wrote local.
   Find out what before replacing it. Only `npm run db:mirror -- --confirm`
   replaces a changed local, and it keeps the old file.
3. **Proving equal.** `npm run db:fingerprint` on both sides; compare the
   whole-database digests, never row counts.

## Changing it

- Never change the fingerprint serialisation (`fingerprintDatabase.test.ts`
  pins it, `\x01`/`\x02` separators included): every recorded digest would
  become incomparable.
- Retention prunes only exact canonical names, keeping every file on the 14
  newest backup DATES plus the newest per month beyond, and only after the
  new backup verified.
- Windows holds a just-closed libSQL file for seconds after a whole-database
  read, so renames retry. Registering the task needs an elevated shell.
- Moving the cron hour means re-scoring every candidate hour for the oldest
  institution's balance age first, and the backup slot moves with it.
- No cloud CI may pull a backup: it would put transaction data in a third
  party (the data-locality HARD RULE).
