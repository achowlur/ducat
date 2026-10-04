---
paths:
  - "src/lib/sync/**"
  - "src/lib/connectors/**"
  - "src/lib/health/**"
  - "src/lib/rates/**"
  - "src/app/api/cron/**"
  - "src/app/providers/**"
  - "scripts/**"
  - "prisma/**"
  - "vercel.json"
  - "package.json"
---

# Rules: sync & data ops

Evidence: docs/conventions/sync-and-data-ops.md. Read it before changing
anything below; several entries record "tried and failed, don't retry".
Running any of these commands against a database: the `cloud-data-change`
skill; backups and the mirror: `backup-mirror`.

Import and sync:
- CSV running-balance ties break by FILE POSITION, not date alone.
- SimpleFIN timestamps are deliberately left alone — any "fix" moves
  correct dates too.
- CSV backfill: --external-id targets an existing account, --until stops at
  feed coverage AND is the only thing stopping an uncapped import rewriting a
  live balance BACKWARD; overlapping rows NEVER dedupe across sources;
  unroutable rows are skipped and reported.
- import:csv --dry-run is a READ-ONLY BRANCH of the writer, never a second
  pipeline: it shares sync.ts's account lookup and dedupe key, is pinned
  against a real runSync by test, and states what it cannot count (transfer
  pairs, insights) instead of implying zero.
- Provider health derives from LOCAL signals only — no network call on
  launch, ever; staleBalanceDays: 5 is deliberate; a new connector owes a
  trust card in providers.ts.
- INVESTMENT accounts are exempt from transaction-gap detection; balance
  staleness covers them.
- A read-only external data fetch is NOT banned. It must: fetch on SYNC,
  store-then-render, gate on an env var that fails closed, key via env, and
  carry a trust card — and the data-locality invariant gets amended
  deliberately, in writing.
- The FRED rate fetcher is that rule's first instance: rides the sync just
  BEFORE insight regeneration (and skips when insights skip), fails closed
  on a missing FRED_API_KEY (zero calls, zero writes), and NEVER fails the
  sync — failures land in rates.mortgage beside the surviving last
  observation; health reads only the stored observation's age
  (RATE_STALE_DAYS: 7); Overview calls getProviderHealth at scope:
  'accounts' so the card costs it no round trip.
- The cron hour (0 23 * * *) is TUNED to minimise the oldest institution's
  balance age — re-score every candidate hour before moving it. Hobby fires
  ANYWHERE in the hour, never early, so the backup slot sits AFTER the hour.

Two databases (the one-line rule is in CLAUDE.md):
- LOCAL MIRRORS CLOUD, always. Anything touching Turso DATA lands on the cloud
  first and reaches local through the nightly mirror (or db:mirror), PROVED
  equal by fingerprint digests, never assumed. Cloud is the only writer; local
  is a mirror, not a second history — a local write makes the mirror refuse.
- The two databases differ in WHICH ROWS EXIST: before deleting a surface,
  check what the CLOUD has that reaches it.
- Never infer deploy state from the served page or the build id — ask the
  operator to read the Vercel dashboard.

Backups and the mirror:
- The nightly mirror writes local ONLY while local still matches the digests
  recorded after its last mirror (data/backups/mirror-state.json): ROWS in ONE
  transaction, never a file swap (local keeps its migration history), proved
  before commit. A refusal leaves local untouched and WARNs on /providers;
  only db:mirror --confirm replaces a changed local, keeping the old file.
- backup:scheduled (the 00:30 UTC Windows task) is the ONLY writer of Setting
  backup.lastRun: CLOUD first, then — after a successful mirror — to local;
  and only AFTER whole-database fingerprints MATCH;
  a failed run writes no row and deletes nothing, so /providers' backup age
  means nights since the last PROVEN copy. Manual cloud:backup never updates it.
- The canonical ducat-YYYY-MM-DD-HHMM.db name is EARNED by verification:
  both backup scripts copy onto .partial and rename only after checks pass;
  failures quarantine as .unverified. Retention prunes only exact canonical
  names — a failed or crashed run must never leave a file it would count.
- The backup wrapper reads .env.backup EXCLUSIVELY — never .env, never the
  shell. Retention keeps every file on the 14 newest backup DATES plus the
  newest per month beyond, and prunes only after the new backup verified.
- The fingerprint serialisation is PINNED (fingerprintDatabase.test.ts),
  its \x01/\x02 separators included; changing the pinned digest orphans every
  recorded digest, so it is done deliberately or never.

Upgrades and schema:
- Pack drift is counted by pendingPackRules and surfaced on Overview's
  review panel (npm run upgrade); rule changes are never auto-applied.
  Transactions with NO categories count the whole pack as pending.
- npm run upgrade regenerates insights on EVERY real run (MONTH only — what
  screens read) and installs the pack only when rules are pending: it always
  writes rows, Overview's silence speaks for RULES alone, and it runs against
  the CLOUD — a local run would make tonight's mirror refuse. It also
  REAPPLIES every rule and the closed box, pack or no pack.
- SCHEMA is the third upgrade axis: npm run schema:push diffs and only ever
  ADDS; one refusal blocks the whole run; an empty database goes to
  turso:push.
- Whether ADD COLUMN is legal depends on the table having ROWS — the delta
  takes row counts before classifying; Prisma's own diff will DROP what
  schema:push refuses — read its script before running any of it.
- A commit adding a `package.json` script owes README's command table a row in
  the SAME commit — commandTable.test.ts fails otherwise, and its INTERNAL
  list, each entry carrying its reason, is the only exemption.
