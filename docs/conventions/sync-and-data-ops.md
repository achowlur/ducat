# Ducat — sync & data-ops conventions

Moved VERBATIM from CLAUDE.md on 2026-08-01 (the split). This file holds the
full evidence — what each rule cost and why alternatives failed. The one-line
enforceable rules live in CLAUDE.md and point here. Additions follow the same
contract: rule line in CLAUDE.md, evidence here, never both in one place.

- CSV running-balance ties break by FILE POSITION, not just date. `Array.sort`
  is stable and real exports are newest-first, so sorting by date and taking the
  last row returned that day's OLDEST posting — a balance short by the rest of
  the day's activity, written to both `Account.balance` and a BalanceSnapshot.
- SimpleFIN timestamps are deliberately left alone: the real feed mixes noon
  UTC, 04:00 (midnight Eastern) and true instants. A late-evening posting on a
  month's last day can land in the next month, but without each bank's timezone
  any "fix" would shift correct dates too.
- CSV backfill (`npm run import:csv`): pass an existing account's `--external-id`
  to backfill INTO it (account lookup falls back to externalId across connector
  types) and `--until=YYYY-MM-DD` to stop at a live feed's coverage start —
  CSV ids are content hashes and feed ids are the feed's own, so overlapping
  rows do NOT dedupe. A mapping with an `account` column (Fidelity) routes rows
  per-account when NO `--external-id` is given; routing is driven by whether the
  caller passes a resolver, so per-account files still work under that mapping.
  Unroutable rows are skipped and reported, never guessed.
- CODE ships with `git push`; DATA does not. There are TWO databases — local
  `file:./data/ducat.db` and the cloud Turso one — and anything that writes
  ROWS (retargeting a rule, recategorizing, `reapplyRules`, regenerating
  insights) lands only on whichever `DATABASE_URL` was set. A green deploy says
  nothing about it. This shipped a half-fix once already: Zego → Rent & Housing
  was verified end to end on localhost, pushed, and the deployment still listed
  Zego as a subscription because only the code half had travelled. So finish a
  data change by running it against the cloud database too, and VERIFY on
  `<your-deployment>.vercel.app` rather than localhost — that is where the data is
  actually read. EVERY script that writes rows prints which database it is
  about to touch, first, for exactly this reason — one definition in
  `scripts/database-label.ts`. `sync:simplefin` was the last one without it and
  the omission cost an hour: a shell still holding the cloud `DATABASE_URL`
  from an earlier command ran a "local" sync against Turso, which reported
  `0 imported` because Turso already had everything, while local sat two
  transactions and several balances behind. `0 imported` does not say WHICH
  database is up to date, and the label is what disambiguates it. The other
  tell is the `since` date: it is derived from that instance's own last sync,
  so it fingerprints the database more reliably than remembering what the shell
  has set.
- CODE and DATA upgrade separately, and only one of them announces itself. A
  pack change arrives with `git pull` and reaches an existing database through
  NOTHING: the app keeps categorizing by the old rule set, a green deploy looks
  identical, and the only symptom is rows landing in the wrong category. The
  `zego|paylease` rule sat uninstalled on BOTH databases for weeks and was
  found only because an unrelated command happened to print the delta. So
  `pendingPackRules` (`sync/rulePack.ts`) counts what the shipped pack defines
  and this database lacks — keyed exactly as `installRulePack` keys it, so the
  number IS what that command would create — and Overview's review panel names
  `npm run upgrade`. Deliberately NOT auto-applied on sync: rule changes can
  move money between categories, and this codebase's grain is visible over
  silent. Anything that must be run once per database belongs in that panel,
  not only in a README nobody re-reads.
- CODE and DATA upgrade separately, and so does SCHEMA — `npm run schema:push`
  is the third one. `prisma migrate deploy` cannot reach libSQL over HTTP, so a
  column added in a release reached the cloud only when someone remembered to
  hand-write the ALTER, and a green deploy says nothing because the build never
  opens the database: the first symptom is a PrismaClientValidationError on
  whichever page reads the new field. It diffs `prisma/schema.prisma` against
  what the database ACTUALLY has, prints the delta, and writes only with
  `--apply`. It only ever ADDS — CREATE TABLE, ADD COLUMN, CREATE INDEX. A
  dropped column, a changed type or nullability, an added or removed foreign key
  (so adding a RELATION is refused — that is a table constraint and needs a
  rebuild), and anything that could be a RENAME are refused with the row count
  at stake printed beside them, and ONE refusal blocks the whole run including
  the additive part: a half-applied schema is harder to reason about than one
  nothing has touched. An empty database is sent back to `turso:push`, using the
  same filter that command uses so the two cannot disagree about which one you
  are supposed to run. Both sides of the comparison go through ONE parser
  (`scripts/schema-delta.ts`) — the desired schema from Prisma's `--from-empty`
  script, the actual one from the CREATE statements SQLite kept in
  `sqlite_master`, which are byte-identical for a database built by
  `turso:push`. Two readers would let the two disagree about nothing at all, and
  a schema tool that invents a delta is worse than one that finds none. The
  parser bug worth not repeating: slicing a statement to the end of its INPUT
  rather than the end of its STATEMENT swept every following statement into the
  first one's tail, which passes the identity test and fails only once the two
  sides differ.
- Whether a column can be ADDED depends on whether that table is EMPTY, which is
  why the delta takes row counts before it classifies anything. Measured against
  libSQL 3.45.1, not read from the documentation, which describes all five
  limits as unconditional and is wrong about three: PRIMARY KEY and UNIQUE are
  refused always, while NOT NULL with no default, a non-constant default
  (`CURRENT_TIMESTAMP`, which is what `@default(now())` compiles to) and
  REFERENCES with a non-NULL default are refused ONLY once the table has rows.
  So the same command can apply cleanly against local and refuse against the
  cloud and be right both times — `TrackedSubscription` is empty here and holds
  two rows there, which is the localhost-hides-a-path hazard arriving in the
  schema tooling. A row-blind answer is wrong on one of the databases whichever
  way it goes. An unknown count reads as "has rows", so forgetting to pass one
  is over-strict rather than over-permissive. Related, and it costs a usage dump
  when you meet it: `prisma migrate diff --from-url` was REMOVED in Prisma 7 —
  the replacement is `--from-config-datasource`, which takes the URL from
  `prisma.config.ts`, i.e. from `DATABASE_URL`. That is the escape hatch the
  refusal prints: `npm run cloud:backup`, then diff the schema against the
  BACKUP FILE, and Prisma writes the table rebuilds this cannot do. It also
  DROPS what `schema:push` refuses to drop, rows and all — pointed at a diverged
  fixture it emitted `DROP TABLE` for a table that had merely been renamed — so
  it is read before it is run.
- The two databases also differ in WHICH ROWS EXIST AT ALL, so localhost can
  hide a code path rather than merely lag it. Deleting Overview's subscriptions
  block was verified green on localhost, where `TrackedSubscription` is empty —
  and the cloud holds two, one of them (`link.com`, $3.89/mo) registered but
  NEVER detected as recurring, because it has too few charges. That row's only
  display in the whole app was the block being deleted, so the change made
  declared money invisible and the local run could not have shown it. The
  general form: before deleting a surface, check what the CLOUD has that
  reaches it, not just what localhost renders. An empty table locally is not
  evidence that a branch is dead.
- An unchanged Next build id is NOT evidence a deploy has not landed, and
  reading it that way cost a wrong call. Vercel reuses the build output when the
  app source is unchanged, so a push of `scripts/`, CLAUDE.md or a package.json
  alias redeploys under the SAME `?_rsc=` id — which is the expected result for
  exactly the pushes this repo makes most often, not a stalled build. There is
  nothing to cross-check it against either: App Router chunk paths carry no
  build id. The deployment being doubted was Ready in production 24 minutes
  before the question was raised, built in 50s. So do not try to infer deploy
  state from the served page. ASK THE OPERATOR to read the Vercel dashboard and
  report the deployment's status, commit and build time — it takes them ten
  seconds and it is the only authoritative answer. The served page still
  verifies the app WORKS (pages render, `/api/diag/timing` answers, row counts
  agree); it just cannot say which build is serving.
- The CRON HOUR decides how fresh the deployment's balances are, because a
  SimpleFIN `balance-date` is when the UPSTREAM last observed the balance, not
  when we synced — and `BalanceSnapshot` is keyed `(accountId, date)`, so a
  sync against an unrefreshed account upserts the SAME row and "Snapshots
  written: 21" is not evidence that 21 balances moved. Measured off the stored
  balance-dates, which ARE the publish times: Fidelity ~08:38 UTC, Chase
  ~16:52, Wells Fargo ~21:59. Settled at `0 23 * * *`, and the reasoning is
  not "after the latest one" but MINIMISE THE OLDEST — score each candidate
  hour by the age of the worst-served institution at that moment. 23:00 gives
  14.4h, against 18.4h at 03:00 and 23.4h at 08:00. 22:00 scores marginally
  better at 13.4h and is REJECTED: it clears Wells Fargo by about a minute, and
  WF was observed publishing at 22:00:59, so that hour would have missed it
  outright. An hour of margin is worth an hour of theoretical freshness.
  Two wrong hours preceded it and both were wrong the same way — fixing the
  institution that prompted the complaint while pushing another one a full day
  back. 08:00 missed Fidelity by 51 minutes; 03:00 fixed Wells Fargo and put
  the cron BEFORE Fidelity's morning publish, so the deployment served a
  two-day-old brokerage balance. Score all of them or repeat the mistake.
  CONFIRMED on the deployment 2026-07-31: the first firing under the new hour
  landed at 23:18 UTC and all eight accounts carried the SAME day's
  balance-date for the first time, the three Wells Fargo rows moving Jul 30 →
  Jul 31. The balances themselves did not change — what the hour buys is a
  fresher observation DATE, not different money, which is the same distinction
  the "Snapshots written: 21" warning above makes. Lateness is now measured over
  four observed firings (08:19, 08:08, 03:43, 03:19, and this one at 23:18):
  Vercel Hobby fires WITHIN the hour, 8-43 minutes late, never early — so the
  firing is identifiable by its minute, and an off-cron row is a manual sync.
  What no cron hour can fix: Fidelity publishes ~08:38 UTC, which is before
  the US open, so its balance is the PREVIOUS trading day's close. One day of
  lag on investment balances is inherent to the feed; the cron only controls
  whether a second day is added on top.
- Provider health (`src/lib/health/`) derives status from LOCAL signals ONLY —
  last sync outcome, feed errors, stale balance dates, transaction-volume gaps.
  No network call on launch, ever. Adding a connector also means adding its
  trust card in `providers.ts`. `isStale` is HARDCODED false in the SimpleFIN
  connector — it exists for CSV, which reports 0/stale with no running-balance
  column — so the ONLY thing that catches a frozen feed connection is health's
  `staleBalanceDays: 5`. Five is deliberate and should stay: a Friday balance
  that does not move until Monday is three days old and perfectly normal, so a
  tighter bar would cry wolf every weekend. The cost is that a genuinely
  stalled connection is silent for five days, which is the accepted trade —
  and the per-account "snapshot <date>" on Overview is what makes it visible
  before then. Observed 2026-07-28: Chase frozen since Saturday with the feed
  itself returning `errors: []`, i.e. the aggregator serving a stale balance
  without flagging it — exactly risk 1 on the SimpleFIN trust card. (It
  recovered on its own the next day, after 3.3 days — which is why the bar is
  5 and not 3: a tighter one would have sent the operator into a bank
  re-authentication flow for a connection that was fine.)
- A read-only EXTERNAL DATA fetch (a mortgage-rate index, say) is NOT banned,
  and misreading the rules that way nearly killed a legitimate feature
  (2026-08-01). The HARD RULE bans analytics, telemetry, third-party CDNs and
  LLM/AI calls — a GET that sends nothing personal is none of them — and the
  data-locality line "the only outbound call is the SimpleFIN feed" is an
  INVARIANT to amend deliberately when such a fetch ships, not a prohibition:
  its purpose is that TRANSACTION DATA never leaves, and a rates fetch carries
  none. What a fetcher must follow is the shape the codebase already uses:
  fetch on SYNC, never on launch (provider health's rule above); store the
  observation and render from the store (the BalanceSnapshot pattern); gate
  behind an env var that FAILS CLOSED when absent (the SIMPLEFIN_ACCESS_URL
  idiom — unset means the feature refuses or falls back to a typed value); key
  via env only; and a trust card in `providers.ts`. The disclosure it owes,
  precisely: the fetch sends the provider an IP, the API key (a persistent
  account identity), the series requested, and — riding the sync — the
  instance's sync schedule. None of that is transaction data, which is the
  argument's core.
  For rates specifically: FRED's API is free and keyed; prefer the DAILY
  Optimal Blue lock series over weekly PMMS (application-based since late
  2022, averaging a week and publishing Thursdays, so 0-6 days stale about
  last week — locks and daily granularity are Optimal Blue's); verify
  series IDs at build time; and even fetched, a typed personal quote OVERRIDES
  the index — a national average is nobody's actual rate.
- INVESTMENT accounts are EXEMPT from transaction-gap detection
  (`GAP_EXEMPT_TYPES` in `health/health.ts`). Their rows are overwhelmingly
  DIVIDEND RECEIVED, which arrive in quarter-end clusters, so volume is not a
  liveness signal: a real Fidelity account ran 52 transactions in June and 2 in
  July and was flagged "dropped off: 2 in the last 30 days vs ~25.7/month"
  every off-quarter month. Widening the window is the obvious fix and it is
  WRONG — measured at 30/60/90/120 days, it drags the BASELINE back into the
  CSV-backfilled era, which captured every trade and statement line where the
  live feed does not, so at 90 days two accounts sat at ratios 0.26 and 0.28
  against a 0.25 threshold (one nudge from firing) and at 120 days the same
  account flagged again for a different reason. Nothing is lost by exempting
  them: a dead brokerage feed stops refreshing the BALANCE, which
  `staleBalanceDays: 5` catches sooner than a 30-day volume window could and
  without depending on whether a dividend happened to be due.
