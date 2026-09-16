# Code, data, schema — three things that upgrade separately

`git pull` (or a deploy) updates the **code**, and only the code. Two other
things live in your **database** and do not travel with it:

- **Data** — categorization rules, categories you created, manual
  categorizations, settings like goals and the cash definition. A new version
  can ship new pack rules; they reach your database through nothing at all
  until you run the command below.
- **Schema** — the table shapes themselves. A local database gets migrations
  through `npx prisma migrate deploy`; a cloud (Turso) database cannot be
  reached by that tool and needs `npm run schema:push`.

Miss this and you ship half-fixes: the code is current, the deploy is green,
and the only symptom is rows quietly landing in the wrong category — or a
`PrismaClientValidationError` on the one page that reads a new column.

## The commands that bring a database up to date

### `npm run upgrade` — after every `git pull`

Installs any rule-pack rules this database is missing, and regenerates the
monthly insight rows — the second part every time, whether or not there were
rules to install. That is the half that matters after a version which changed
no rules at all: the analyzers are code, the numbers on your screens are rows
in your database, and nothing else brings the two back into agreement.
Idempotent: it creates only what is absent and never edits a rule you changed
yourself (your own rules outrank the shipped pack anyway). `-- --check`
reports the gap without writing.

**How you know you need it:** run it after every `git pull`, full stop — a
release can change what the analyzers compute without shipping a single rule,
and nothing announces that. Overview's "Needs review" panel counts missing
RULES and names this command when a database is behind on them; its silence
means the rules are current, not that this command has nothing to do.

### `npm run schema:push` — after a version that changes the schema

Diffs `prisma/schema.prisma` against what the database actually has, prints
the delta, and writes only with `-- --apply`. It only ever **adds** (tables,
columns, indexes); anything destructive or ambiguous — dropped columns,
changed types, possible renames — is refused with the row count at stake, and
one refusal blocks the whole run. Safe to run twice: after applying, it
reports nothing to do. An empty database is redirected to `turso:push`
instead.

**How you know you need it:** a `PrismaClientValidationError` ("Unknown
field") on whichever page reads the new column. Run both commands after a
version that changes the schema: `schema:push` for the columns, `upgrade` for
the rules.

### `npm run goals` and `npm run accounts:cash` — when you configure

Savings goals and the "counts as cash" account list are per-instance settings
stored in the database. On a local-only install, run them locally; with a cloud
deployment, run them against the cloud and let the mirror bring them down (below).
Both print the current state when run with no flags; read that listing before
adding, because re-adding an existing goal creates a duplicate rather than
being ignored.

## Running local + cloud: the two-database model

If you deployed to your own cloud ([DEPLOY.md](../DEPLOY.md)), there are two
databases but **one writer: the cloud**. Run `upgrade`, `goals` and
`accounts:cash` against the cloud only, pointing the environment at Turso for
that one command, in a throwaway terminal you then close:

```bash
DATABASE_URL="libsql://…turso.io" TURSO_AUTH_TOKEN="…" npm run upgrade
```

The nightly scheduled backup then mirrors local from the cloud — start it once
with `npm run db:mirror -- --confirm` (DEPLOY.md, "Scheduled local backups").
Don't run these commands against local: a local write makes that night's mirror
refuse, so local stops updating and /providers says so. The **schema** is the
exception, because the mirror copies rows, not table shapes: after a version
that changes the schema, run `schema:push` on the cloud **and**
`npx prisma migrate deploy` locally, or the mirror fails until they match.

Two habits keep this honest:

1. **Read the first line.** Every script that writes rows prints which
   database it is about to touch before doing anything, e.g.
   `Database: LOCAL — file:./data/ducat.db`. A shell can still be holding the
   cloud URL from an earlier command, and "0 imported" does not tell you
   which database is already up to date — the label does.
2. **Verify where the data is read.** After a data change meant for the cloud
   instance, check the deployed app, not localhost. A green deploy says
   nothing about data.

Everything you do by hand — rules, manual categorizations, dismissals, goals —
belongs on the cloud instance, and reaches local through the mirror. Work done
only on localhost is either refused by the mirror or, after a confirmed
`db:mirror`, replaced — [DEPLOY.md](../DEPLOY.md) covers this under "Living
with two copies".
