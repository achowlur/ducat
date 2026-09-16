# Ducat — sync & data-ops conventions

> Every figure in this file is scaled by one unrecorded constant: ratios are exact, no absolute value is real. See [publishing.md](publishing.md).

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
- `import:csv --dry-run` (BUILT 2026-08-08) is a READ-ONLY BRANCH of the path
  that writes, and the distinction is the whole design. A preview that
  re-implements the pipeline is worse than none: it is confidence without
  evidence, handed to someone about to write rows they cannot take back — an
  import has no undo, since a re-downloaded export whose text differs by one
  character re-imports rather than dedupes and nothing records which file
  produced which rows. So `previewImport` is handed the SAME connector object
  `runSync` would get, and calls `sync.ts`'s own `findExistingAccount` and
  `existingTransactionKeys`/`transactionKey` — both extracted from
  `runPipeline` in the same commit, so the writer is their only other caller.
  The account lookup is the one that had to be shared: its externalId-only
  fallback is what makes a backfill land IN a live account, and a preview
  holding a private copy would announce CREATE for precisely the invocation the
  flag exists to check, talking the operator out of a backfill that was going
  to work. The rule matcher and the payee grouper are already pure and are
  called, not copied — the grouper against the same
  `categoryId: null, flow != TRANSFER, reimbursesId: null` selection
  `/transactions?payees=1` makes.
  ANTI-DRIFT IS A TEST, not a rule, for the reason the command table already
  learned: `previewImport.test.ts` runs the preview and then a real `runSync`
  over the same fixture and asserts they agree about rows landing, rows already
  present, accounts created, snapshots and rules fired; a second test censuses
  EVERY table before and after (not just the ones a preview "should" touch —
  the failure mode is a write added to the pipeline later) and asserts nothing
  moved, `SyncLog` included, since `runSync` logs every run including the ones
  that throw.
  IT REFUSES TWO ANSWERS out loud: transfer-pair linking and insight
  regeneration, both of which run over rows the preview has not written. That
  makes the payee-decision count an UPPER BOUND — every pair linked takes two
  more rows out of the review queue — and the report says so rather than
  letting the number read as exact. Silence would have been the fabrication.
  WHAT BUILDING IT FOUND, which is the argument for having built it: `--until`
  is silently the BALANCE GUARD. With the cap set, `listAccounts` reports
  `isStale` and nothing is written; without it, a mapping carrying a
  running-balance column reports the file's newest row as the CURRENT balance
  and `runSync` writes it — the `foreign` check protects institution, name and
  currency, never the balance, and no date comparison stops it moving backward.
  The preview prints `REPLACES <live balance> dated <live date>` and a WARNING
  when the write would date the balance earlier; the write path was left
  unchanged, because a refusal there is a behaviour change and this was a
  reporting job.
  WRITE-BY-DEFAULT WAS KEPT deliberately, matching `import:balances` — the
  closest sibling, also a file importer, also previewed with `--dry-run` —
  rather than `schema:push`/`turso:copy`, which are dry by default. Flipping it
  would have broken every documented invocation and every operator's habit.
  PROVED ON THE COMMAND, not only in the suite: against a throwaway database,
  `npm run db:fingerprint` read `f3d007c9c97ce0b1` before and after a dry run
  that reported it would import 4 rows, and the real import of the same file
  landed exactly the counts the preview had printed (1 account created, 10
  imported, 0 already present, 6 rules applied).
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
- ANALYZER MATH IS THE THIRD THING `git pull` CARRIES AND THE DATABASE DOES NOT,
  and `npm run upgrade` skipped it from the day it shipped (2026-07-31) until
  2026-08-08. `pendingPackRules === 0` hit an early return printing "Nothing to
  do.", and `generateInsights` sat BELOW that return — under a comment stating
  the opposite intent, which is the tell worth remembering: the decision to
  regenerate unconditionally had already been made and written down, and the
  control flow quietly defeated it. So the one command every doc points at after
  a `git pull` did nothing at all after a release that changed only analyzer
  math, which is this repo's commonest kind of release. Insights are COMPUTED
  ONCE AND STORED; changed analyzer code reaches a screen through nothing else.
  The fix is call-site sequencing only — early return deleted, `installRulePack`
  and its result logs wrapped in `if (pending > 0)`, `generateInsights` left
  unconditional below. `sync/rulePack.ts` and `insights/engine.ts` were
  deliberately not touched.
  FOUR DECISIONS CAME WITH IT, each recorded because the next reader will ask.
  (1) `--check` gained a second line ("A real run regenerates the monthly
  insight rows whatever that count says"). Its whole job is to report what a
  real run would do, and the count it prints now decides the pack install ALONE
  — reporting the count by itself would understate the run, which is the same
  class of mistake the bug was. (2) "Nothing to do." was DELETED rather than
  reworded: there is no longer a real run that does nothing, so any wording of
  it is false. The rule-pack line above it ("up to date — nothing to install")
  survives, because that claim was always scoped to the pack and stays true.
  (3) MONTH stays HARDCODED, and no `--granularity` flag was added. Every screen
  reads MONTH rows only (`ui/insightRows.ts` filters to them), so WEEK/QUARTER/
  YEAR rows exist only where somebody ran `insights:generate --granularity=` and
  are read by nothing; a flag would hand the operator a fourth thing to remember
  to run four times, which is precisely the failure mode this command exists to
  remove. Accepted and documented rather than fixed: those rows stay stale until
  `insights:generate` refreshes them. (4) NO PURE FUNCTION WAS EXTRACTED, against
  the repo's usual grain (`schema-delta.ts`, `retention.ts`, both pinned by
  tests). The reason is that the extraction cannot fail on this bug: a
  `planUpgrade(pending, checkOnly)` returning two booleans pins the DECISION,
  while the regression lived in `main()`'s control flow — a future early return
  above the call site passes that test untouched. Worse, the natural call shape
  is `if (plan.regenerateInsights) …`, which puts the regeneration back behind a
  boolean the moment the fix removes one. `upgrade.ts` remains untested (its
  `main()` runs at module load), and the guard is that the comment now describes
  the code instead of contradicting it.
  WHAT THIS MAKES TRUE OF THE TWO DATABASES: `upgrade` is now a GUARANTEED
  row-writer, so the run-once-per-database rule bites every single time rather
  than only when the pack moved. The caveat that follows, stated so nobody reads
  it as a broken mirror: cloud and local hold DIFFERENT TRANSACTION SETS by
  design (local runs a nightly sync behind — see the entry in the backlog), so
  running `upgrade` on both produces Insight rows that legitimately DO NOT
  fingerprint-match. Regenerating is not a data change to be mirrored down; it
  is each database recomputing from what it holds. And the digest moves even on
  ONE database with nothing else changed: measured locally on 2026-08-08, a run
  against a current pack left every other table and all 22 aggregates
  byte-identical while `Insight` went `0f13a2df71f6b7bf` → `a8b4b2e72ada0f38`
  at the same 225 rows, because regeneration DELETES AND RECREATES the rows and
  their ids travel into the hash. So a whole-database digest taken after an
  upgrade cannot be compared with one taken before it, on either side.
  THE ONE IRREVERSIBLE EFFECT, and it is small but real: regeneration carries
  the `dismissed` flag forward for insights of the same identity (`identityOf`
  in `insights/engine.ts`, pinned by `engine.test.ts`), so ordinary dismissals
  survive. A dismissed insight the CHANGED analyzer no longer emits has no row
  to carry the flag onto, and its dismissal is gone for good. That is the price
  of the command doing what it always said it did.
- README's command table DRIFTS BY SHIPPING, which is why remembering does not
  fix it. The table is the index of everything an operator runs; it was audited
  and repaired on 2026-08-01 (the user-docs commit) as part of writing the user docs, and by
  2026-08-05 it was wrong again — and FOUR of the six commands missing that
  second time had been added in the two days AFTER those docs were written. So
  the failure mode is not neglect between audits, it is the ordinary act of
  landing a script: the commit that adds it is the only moment anyone knows
  what it does, and that is exactly the commit that does not think about the
  README. A table repaired by hand every few weeks is a table that is wrong
  most of the time.
  The 2026-08-06 repair found the backlog's own list UNDERCOUNTED, which is the
  same lesson once more: it named six missing commands and there were SEVEN —
  `simplefin:claim` was missed because it appears in README PROSE, and a
  reader checking "is it documented?" saw it and moved on. Prose is not the
  index. Six rows already IN the table had also drifted, two of them in a way
  the README makes load-bearing: it states that rows marked "names the database
  first" print their target, so the ABSENCE of that marker is itself a claim,
  and both `insights:generate` and `import:balances` had gained the label in
  code while their rows still denied it. `rules:retarget` was the worst — the
  row described only its original `--category` mode, and the command now
  requires a `--match=` selector the row never mentioned, so the row could not
  be followed to a working invocation at all.
  The durable fix is `scripts/commandTable.test.ts`, not the convention line:
  it fails `npm test` when a script has no row, when a row names a script that
  no longer exists, and when the INTERNAL exemption list goes stale. Written as
  a test rather than a rule because the rule form is precisely what had already
  failed twice. INTERNAL currently exempts five, each with its reason recorded
  beside it: `postinstall` and `lint` (never typed by a user of the app),
  `turso:baseline` (a sub-step of `turso:push`, documented in DEPLOY.md), and
  `build`/`start` — those two deliberately live in the "Measuring performance"
  prose instead, because a bare table row would strip the
  never-build-while-the-dev-server-runs hazard off the one command in the repo
  that corrupts `.next/`.
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
- BUILT 2026-08-02 (wave1/fred-rate): the FRED fetcher is that paragraph made
  code, and the series was verified on the page the day it was hardcoded, not
  from memory. OBMMIC30YF is "30-Year Fixed Rate Conforming Mortgage Index" —
  Optimal Blue, DAILY, percent, computed from actual locked rates, observed
  2026-07-30 = 6.651 with "Updated: Jul 31 7:04 AM CDT" — while MORTGAGE30US
  (Freddie Mac PMMS) read 6.66 for the same date but is "Weekly, Ending
  Thursday" and application-based since 2022-11-17, which is why the daily
  lock series won. Three shapes worth keeping: FRED sends values as STRINGS
  with "." for a day without a release, so the fetch asks for the newest 8
  (sort_order=desc) and takes the first that parses in (0, 30] — a holiday
  weekend of placeholders is data, not an error. The Setting (rates.mortgage)
  stores the last observation AND the last failure side by side, because a
  failed fetch must never cost the observation that still stands, and the
  stored failure is what lets /providers say why the number stopped moving.
  And FRED is a ProviderId, deliberately NOT a ConnectorType: it owes a trust
  card and health, but widening ConnectorType would let a rates feed
  masquerade as a transaction source everywhere Account.connectorType is
  read. Health is the stored observation itself — RATE_STALE_DAYS: 7 on the
  OBSERVATION date (daily series, one-business-day publication lag, so a long
  holiday weekend legitimately reads 4-5 days old), the same reasoning as
  staleBalanceDays: 5 one notch looser. Error strings are built from our own
  text only: the request URL carries the API key, so no failure path may echo
  the URL into anything stored or logged — probed adversarially with a marker
  key through undici cause-chains, malformed bodies and keyed error bodies,
  zero leaks. Two facts the adversarial review added: the /providers card
  renders even BEFORE the key is set ("Not set up yet" plus the full trust
  card) — that is the page's own readable-before-connecting doctrine, wanted,
  so an operator reads the deal before opting in, and Overview passes
  scope: 'accounts' to getProviderHealth so the card's Setting read costs it
  no Turso round trip; and the fetch rides EVERY sync invocation, so a
  multi-file CSV import fetches once per file — one GET per invocation was
  accepted rather than plumbing a batch flag nothing else needed. The trust
  banner's local-mode sentence now names both outbound calls; keep it in step
  with any future fetcher.
- The "This instance" block owes the same THREE PARTS a connector card does
  (2026-08-03). Every connector below it carried a data path, a numbered
  "Residual risks you are accepting" list and a revocation note; the block
  describing where the data actually RESTS carried only the reassuring half,
  ending "so no third party custodies it" with nothing under it. It was the
  one element on the page with no risks list, and the counterweight DEPLOY.md
  LEADS with reached the page nowhere: "encrypt", "end-to-end" and "read your
  data" each appeared zero times. Turso can read the data while serving
  queries — encryption at rest is not encryption from the operator of the
  database — this is deliberately not E2E, and the password gate is the whole
  perimeter. Cloud mode only; local mode's sentence was already complete. An
  ADDITION, never a softening: the existing sentence is CLAUDE.md's own claim
  and is correct, and what was missing is what you accept by believing it.
  The page also states the sync CADENCE, which it previously could not answer
  at all — `schedule`, `cron`, `nightly` and `23:00` appeared zero times,
  while the FRED card's own residual-risk line said FRED can see the key ask
  for the series "at your sync times", naming a fact the page never gave.
  Read from `vercel.json` (`cronSummary`) rather than retyped, and pinned by
  test against the shipped `0 23 * * *`, so the sentence cannot drift from the
  cron that fires. Only the daily shape is put into words; anything else
  prints verbatim, because "once a day" over a cron firing four times is
  exactly the confidently-wrong claim this page exists to refuse.
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

- LOCAL MIRRORS CLOUD (2026-08-04). The rule: anything touching Turso DATA
  lands on the cloud first, is CONFIRMED there by the operator, and is then
  copied down to local — and the two are PROVED equal rather than assumed.
  Cloud is the only writer; local is a mirror, not a second history.
  This SUPERSEDES the older "leave the local database frozen as a realistic
  development fixture" in DEPLOY.md, which has been amended. The half of that
  advice which survives is the half that mattered: never point
  `sync:simplefin` or a CSV import at local once the cloud is real, because
  two independent writers is exactly how the hand-made work — rules, MANUAL
  categorizations, dismissals — diverges beyond reconciling. Mirroring
  DOWNWARD is the opposite operation: it makes them converge. A local database
  that has silently drifted is worse than none, being both a fixture that no
  longer reproduces the bug you are chasing and the thing you would restore
  from on the day you need it most.
  The MECHANISM has a guard worth knowing before you meet it: `turso:copy`
  refuses a destination holding any transactions ("a one-way copy into a fresh
  instance, not a merge"), so the local file is moved aside and recreated
  rather than written over in place. Full procedure in DEPLOY.md under "Bring
  local back into line with the cloud".
  PROOF is `scripts/fingerprint-db.ts`, and it exists because counts are not
  proof. `cloud:backup` already verifies nine row counts and eight aggregates,
  which answers "did the copy land" and not "is every row identical" — a table
  can hold the right number of rows summing to the right total while a
  category changed, a `dismissed` flipped, or a rule was edited. The
  fingerprint hashes every row of every table, sorted so physical order cannot
  matter, and reduces to one `WHOLE DATABASE` digest to compare by eye. It
  runs against `file:` and `libsql:` through the SAME client deliberately:
  values that took different paths out of the database would compare the
  paths, not the data.
  TIMING is part of the rule. Mirror AFTER the nightly cron, never before —
  `0 23 * * *` UTC with Vercel Hobby firing 8-43 minutes late, so 23:50 UTC
  clears it. Proved the hard way on the day this was written: a backup taken
  at 18:54 EDT diverged from the cloud six minutes later when the 19:00 cron
  ran, and the fingerprint correctly reported eight tables differing. Reading
  that as corruption would have been the wrong conclusion — the giveaway was
  +1 SyncLog, +21 transactions and +21 BalanceSnapshots, exactly one snapshot
  per account, which is the sync pipeline's signature and nothing else's. The
  hand-made digests (Rule, Category, TrackedSubscription) were byte-identical
  throughout, which is what said the backup was intact.
  The MISSING STEP, found the first time the procedure was walked (2026-08-04):
  `turso:copy` copies ROWS, not TABLES, so a destination moved aside has
  nothing to copy into and needs `prisma migrate deploy` first. The failure is
  not obvious — the libSQL client CREATES the missing file on connect, so the
  evidence is a 0-byte `data/ducat.db` and an error counting `Transaction`,
  which reads like a copy bug rather than a missing schema. The `sqlite`
  provider accepts `migrate deploy` against a `file:` URL; only `libsql://`
  over HTTP is out of its reach.
  Mirror from the verified BACKUP rather than from Turso when one exists: no
  credentials, no network, and no chance of a sync landing mid-transfer. The
  backup has already been proved digest-equal to the cloud, so it is the same
  data by definition.

- SCHEDULED LOCAL BACKUPS (built 2026-08-04, the day of the outage that
  justified them). Turso's us-east-1 router returned 502 to every query for
  over two hours; nothing was lost, but there was no local copy at the time,
  and `cloud:backup` cannot run against an unreachable database — the one
  moment you want a backup is the one moment you cannot take one. Free-plan
  point-in-time recovery reaches back 24 hours and lives in the same failure
  domain as the outage. So a Windows scheduled task fires
  `scripts/backup-scheduled.ts` nightly at 23:50 UTC (after the `0 23 * * *`
  sync cron plus Hobby's 8-43 minutes of lateness — the same timing rule the
  mirror procedure above records, and got wrong by hand on the day it was
  raised).
  WHERE THE SIGNAL LIVES was the one design question left open, and the
  answer is the CLOUD, for a reason worth keeping: the `backup.lastRun`
  Setting exists so /providers can say "last local backup: N days ago" and
  escalate silence, and the operator reads /providers on the PHONE — the
  cloud instance, whose filesystem could never see `data/backups/`. A
  local-only Setting (invisible where it is read) and a
  newest-file-in-the-directory derivation (impossible where it is read) both
  fail the same test. The apparent circularity — the backup writes to the
  cloud, which the mirror rule says must then be copied down — dissolves
  because the wrapper writes the byte-identical value to BOTH databases in
  the same run, cloud first: the wrapper IS the mirror step for the one row
  it owns, and nothing is left over to re-mirror. Consequences accepted with
  eyes open: each backup FILE carries the PREVIOUS run's Setting (the row is
  written only after the new file is verified), which is truthful — a
  restored backup reports the last backup that existed when it was taken;
  and a run that verifies but fails the cloud Setting write reports failure
  while the file quietly exists, which errs on the side the doctrine wants
  (claiming less coverage than you have, never more).
  THE SETTING MEANS VERIFIED. It is written only after the whole-database
  content fingerprints of the new file and the cloud MATCH — counts and
  aggregates still run first, but they are blind to a changed category or a
  flipped `dismissed` — so the age /providers renders is "days since the
  last PROVEN copy", not "days since the task last tried". A failed run
  writes no Setting and deletes no file. Manual `cloud:backup` runs do not
  update it either: they count-verify only, and the line must never claim
  fingerprint proof it does not have.
  ESCALATION counts MISSED NIGHTS, and the arithmetic is worth stating
  because the first draft got it wrong: the Setting's `at` lands minutes
  after the 23:50 UTC slot, so floor(elapsed/24h) EQUALS the number of
  silent nights — age 1 is one missed night (a machine off overnight —
  travel makes that routine): OK; age 2 is the second silent night, the task
  not firing: WARN (`> 1`). Past a week (age 8+): ERROR, the level a failed
  sync gets. The draft shipped WARN at `> 2` believing age 2 meant one
  missed night; the adversarial review proved age 2 is only reachable after
  TWO missed slots, so every document promised a warning one night earlier
  than the code delivered. Floor-of-elapsed needs no headroom — it already
  IS the night count. The same review separated the UNITS: escalation uses
  elapsed nights, but the page's "today / yesterday / N days ago" words are
  CALENDAR words and come from calendarDaysAgo (ui/format.ts), counted in
  the display zone — floor-of-elapsed says "today" beside a timestamp the
  reader can see is yesterday's. The escalation sentence carries no number
  at all, so the one printed count (calendar) can never contradict it.
  Deliberately tighter than `staleBalanceDays: 5` — that watches a
  third-party feed's publication cadence; this watches our own task, which
  has no holidays. Absent the Setting entirely, /providers renders NO backup
  line (the FRED precedent: an instance that never opted in carries no
  signal), which is what keeps the line honest for local-only users who
  have no cloud database to back up.
  RETENTION is "~14 dailies plus one a month", made precise as: every file
  on the 14 most recent DISTINCT DATES present stays — dates, not files, so
  a manual backup beside the scheduled one is never deleted; distinct dates
  PRESENT, not calendar days, so a week of downtime still leaves 14 restore
  points — and beyond those dates the newest file of each calendar month
  survives. Only exact `ducat-YYYY-MM-DD-HHMM.db` names are ever candidates;
  `backup.log`, superseded files and anything hand-renamed are ignored by
  construction. Pruning runs only AFTER the new backup has fingerprint-
  verified, so a failing job can never eat history. `planRetention` is pure
  and clock-free (scripts/retention.ts, pinned by tests).
  THE CANONICAL NAME IS EARNED, and this is what makes the previous sentence
  actually true — the adversarial review caught the gap in the first draft:
  a failed run that leaves its file under the canonical name has poisoned
  retention, because retention judges by filename alone. The leftover counts
  as a daily date, and once its month ages out of the 14-date window,
  newest-of-month elects it the month's PERMANENT keeper — a later healthy
  run then deletes every proven backup of that month and preserves the one
  file known to be bad. So both backup scripts copy onto `.partial` and
  rename to the canonical name only after verification passes (a hard crash
  leaves `.partial`); a verification failure renames to `.unverified`
  (inspectable forever, candidate never). The invariant: a file named
  `ducat-YYYY-MM-DD-HHMM.db` is always a backup that passed its checks —
  count/aggregate for a manual `cloud:backup`, fingerprints for the
  scheduled wrapper. Both quarantine suffixes are pinned in
  retention.test.ts as never-touched.
  CREDENTIALS come from `.env.backup` (gitignored via `.env*`), read
  EXCLUSIVELY — never `.env`, which points at the local database, and never
  the shell, so a terminal still holding cloud variables cannot redirect the
  script, and the Task Scheduler's bare session behaves identically to a
  hand run. The task itself runs S4U ("run whether user is logged on or
  not", no stored password), which is what makes it truly windowless — the
  operator asked for zero popups — plus StartWhenAvailable so a machine
  asleep at 23:50 UTC runs the backup on wake (late is always safe; only
  EARLY captures yesterday).
  A TRAP found during the build, recorded because it will bite again: the
  fingerprint's row serialisation joins fields with `\x01` and rows with
  `\x02` — RAW control characters in the original inline code, invisible in
  an editor, and silently dropped the first time the hashing core was
  extracted to `fingerprintDatabase.ts`. Every digest changed; on identical
  data the cloud-vs-file comparison would have failed every night. They are
  escape sequences now, and `fingerprintDatabase.test.ts` pins the exact
  serialisation with a fixture digest — if that constant ever changes, every
  recorded digest (mirror proofs, stored `backup.lastRun` rows) becomes
  incomparable with new output, which is precisely what the pin is there to
  make deliberate.
