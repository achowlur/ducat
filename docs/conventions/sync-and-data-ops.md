# Ducat — sync & data-ops conventions

> Figures in this file are not real. Those present at publication are scaled by one unrecorded constant, so their ratios are exact; any added since are invented. See [publishing.md](publishing.md).

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
- PDF STATEMENT IMPORT (BUILT 2026-10-15, `npm run import:pdf`). History older
  than any CSV download window comes from the bank's PDF statements, and the
  rule that shaped it is the operator's: a transaction already stored must not
  be added again, though the feed and a CSV each stored it under an id of
  their own. What each part cost:
  POSITION, NOT TEXT. A Wells Fargo deposit statement prints deposits and
  withdrawals in separate columns with no sign, so a number's meaning is the
  column it sits under. `src/lib/connectors/pdf/lines.ts` keeps every text
  item's x, and each parser finds its columns from the table's own header row,
  so a layout shifted a few points between years still lines up. An amount
  under no column refuses the statement.
  THE STATEMENT CHECKS ITSELF, AND THAT IS THE TEST THAT MATTERS. Opening
  balance plus every row must equal the closing balance to the cent, and every
  total the statement prints must match the rows it covers: Chase's summary
  per section, Wells Fargo's summary, Totals row and the ending daily balance
  on each day's last row. A statement failing any of them is refused WHOLE.
  On the first real run every refusal was a parser bug, and every one named
  its statement and reason; none was a wrong row that slipped through.
  THE BUGS REAL STATEMENTS FOUND, none of which an invented fixture would have
  shown, each now pinned by an invented one in its shape:
  - Chase draws bold headings twice, so "ACCOUNT ACTIVITY" extracts with every
    letter doubled; the parser keys on the column header and section names,
    which print once.
  - Chase prints summary amounts with a leading "+".
  - Some older Wells Fargo statements print only the statement date, set so
    close to the page marker that the two read as one cell ("June 9, 2020 n
    Page 1 of 3"): a date is read from the START of a cell, never mid-cell.
  - A description long enough to reach the amount column merges with the
    amount; a trailing money token on a cell ending at the column is split off.
  - A card lists a late-posted row (a refund) by its ORIGINAL transaction
    date, months before the period it appears in. A slack window kept failing
    as rows got later, so the rule became the one that cannot: a statement
    never lists a future row, so a row's year is the latest that does not put
    it after the closing date. And because the feed dated that row when it
    POSTED, it also matches a stored row of its amount anywhere in its
    statement's period; without that it was a gap and would have been stored
    twice. Then the operator's call: such a row is DATED ON ITS STATEMENT'S
    OPENING DAY, the merchant's date kept in its description as
    "(transaction date MM/DD/YYYY)", because the money moved in that period
    and a month already closed should not reopen for it. The merchant key is
    read from the printed text, so the note never splits a payee in the rules
    or the grouped review. A lag of a week or less keeps its own date, as a
    CSV export would.
  THE DUPLICATE RULE is `src/lib/sync/overlap.ts`: same account, same amount
  to the cent, dates within `--match-days` (4: a card statement lists the
  transaction date, a feed often the posting date), matched as a MULTISET so
  two identical coffees on one day stay two rows. A surplus among rows on
  different days is AMBIGUOUS and never added, because which one is missing
  cannot be known. Description similarity was planned as a tiebreak and was
  not needed: the first real run matched every overlapping row with no
  ambiguous row at all. Rows inside the stored dates that match nothing are
  GAPS, added, and the dry run lists every one.
  ONE PLAN, TWO PATHS: `planStatementImport` is read-only and both the dry run
  and the write consume it, the dry run through `previewImport` with the same
  connector `runSync` gets; `statementImport.test.ts` pins the two together.
  The import never writes `Account.balance` (statements are history); each
  statement's close becomes a snapshot. `ImportBatch` (file name, hash,
  account, period) is written LAST with an id derived from the file's hash, so
  a write that fails midway records nothing and its re-run is not refused as
  already imported.
  ONE FILE, SEVERAL ACCOUNTS. Fidelity's Investment Report covers every
  account the holder has, each under its own "Account #" header, so a layout
  returns a LIST of statements; each is reconciled on its own and the file is
  refused whole if any fails. The batch id and the same-file check key on the
  file AND the account. An investment's value moves with the market, so its
  check is beginning + rows + the PRINTED "Change in Investment Value" =
  ending (`marketChange`): the statement's own figure, never one derived, or
  the check would hold by construction. Only money crossing the account is a
  row (the closed box: trades, dividends, reinvestments and core sweeps stay
  inside); a summary line moving money through a section the parser does not
  read REFUSES the statement and names the line. Two guards came with it:
  `--external-id` names ONE account, so under it a file holding several is
  skipped rather than poured into it; and a statement whose period OVERLAPS
  another for the same account (a quarterly report beside a monthly one) is
  skipped, because rows are matched against the database, never against
  another statement in the same run. Periods sharing only a boundary day do
  not count as overlapping.
  The first real run refused nearly every report with "rows add up to #.##,
  the statement prints #.##" and nothing else, because the summary reader
  SKIPPED a line whose figure it could not place, and a masked report cannot
  show which. So the summary is read strictly: every line between the
  beginning and ending value that prints a figure this period must sit under
  Additions or Subtractions, each heading's lines must add up to it, and a
  refusal quotes every label it read. The same run showed `--share` printing
  whole account numbers: its mask kept any digit run next to a dash (for ISO
  dates), and a brokerage account number has one. It now keeps only an ISO
  date, and text a reason quotes from a statement is masked as a row is.
  The strict reader's first run named the cause at once: the real reports set
  the summary 18 points left of the dump the parser was written from (labels
  at x 31 and the lines under them at 40, against 49 and 58), so "Deposits"
  sat left of the fixed indent and belonged to no heading. Positions are now
  read RELATIVE to the page's own headings: a line is under Additions when it
  is set in from Additions, a wrapped description continues under the
  Description column. Every line under Additions or Subtractions is read
  through the section of its own name (Exchanges In, a fee as well as
  Deposits), since each is money crossing the account. A summary with no
  change-in-value line at all (an account holding only a balance) is no
  change, which the value check still tests. The YEAR-END report is refused
  by name: one summary of the whole year, which overlaps every monthly report
  and which a December monthly report sits beside. And the dry run's list of
  stored rows no statement explains leaves out an investment account's
  trades and dividends (the closed box's own test), which no investment
  statement lists: on the first run they buried the rows worth a look.
  Brokerage words joined the mask's vocabulary ("Exchanges" printed as
  "Xxxxxxxxx"), and `pdf:layout --pages-with` finds pages by their REAL
  text, so a page can be asked for by a word the mask hides.
  With `pdf:layout` run on the real reports (masked), the rest fell out:
  an account with ONE activity table lists an exchange as a "Transferred
  From/To" row in it, not a section of its own, so an exchange with no
  section is read from those rows; securities moved IN KIND ("Transfers
  Between Fidelity Accounts", a heading of its own) carry a quantity and no
  amount, but print each one's VALUE OF TRANSACTION below it on both sides,
  so they are one row per security at that value; fees and a trade's
  transaction cost are counted with the change in value (as netWorth.ts
  already counts an advisory fee inside the account), never as rows; and an
  edge mark and the footer's code past the Amount column are never an
  amount. The last find was the one that mattered: deposits came out as
  gaps beside stored rows the feed had signed NEGATIVE, the known
  disagreement between SimpleFIN and Fidelity's own records, so they would
  have been added twice. In an investment account a statement row now
  matches on the amount's magnitude.
  AN ACCOUNT NO FEED EVER HAD. The reports also covered an account closed
  before the feed was connected, so Ducat had never had it and its value
  over the years it was open was missing from net worth. `--create-account=<last four>`
  makes it from its statements: named with its digits so later runs match it,
  its balance its last close (the one Account.balance an import writes, as
  nothing else ever will), and created FIRST in the write, so a write failing
  after it simply matches it on the re-run. Two accounts already carrying
  those digits is ambiguity, never a reason to make a third.
  THE OPENING ZERO. Net worth could draw no month before the newest account
  existed: an account with no value in a month made that month unknown, and
  one opened late had none before. A first statement that opens at zero, with
  nothing stored before it, IS the account being opened, so the import writes
  that zero on the statement's first day; with it, net worth can count the
  account as nothing before then. It had to land before the real import,
  because a statement already imported is never read again.
  SNAPSHOTS BEFORE THE SYNC. The real import emptied the net worth line: the
  write ran its rows through runSync, which regenerates insights, and only
  then stored the statement snapshots. The account it had just created had
  none yet, so every month counted it unknown and no month was drawn. The
  data was whole; `insights:generate` restored the line. The write now stores
  the snapshots first, and statementImportInsights.test.ts pins it on a
  database of its own, since another test's account would hide it.
  SHARING A LAYOUT WITHOUT SHARING A STATEMENT. Parsers were written from
  `npm run pdf:layout` dumps the operator pasted. Masking digits alone was not
  enough: a statement prints the holder's name and address and the people paid
  by Zelle. So words are masked too, except statement vocabulary
  (`scripts/layoutMask.ts`), and bank and product names stay OFF that list
  because Chase, Wells, Bill, Cash and Page are also people's names. The
  import's own report has `--share` for the same reason: counts, x positions
  and statement dates survive, amounts, account digits and every listed row do
  not. A refusal reports where text sat and its SHAPE (letters as X, digits as
  #), never what it said.
  THE SCHEMA, AND WHAT RUNS THE BACKUP. A foreign key is a table constraint
  SQLite cannot add to a populated table, so `Transaction.importBatchId` is a
  plain nullable column, the shape `schema:push` adds; `ImportBatch` is a new
  table. A new table must join `TABLES` in `scripts/copyDatabase.ts` or every
  backup and mirror silently drops it; that moves the pinned overall
  fingerprint, never a table's digest, which `fingerprintDatabase.test.ts`
  now proves by recomputing the old value over the old list. And the 00:30 UTC
  backup builds its file from the MAIN checkout's `prisma/schema.prisma` and
  `TABLES`, so schema work stays in a worktree until rollout: the cloud (and
  the demo's own database) take the schema BEFORE the merge, since old code
  ignores a new column and new code needs it, and the rest (pull, local
  schema, one `db:mirror -- --confirm`, since a new column changes local's
  recorded digests) lands the same day before that backup runs.
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
  A FRESH INSTALL WAS INVISIBLE TO IT until 2026-10-03. Only the demo seed
  installs the pack, so a first SimpleFIN sync leaves transactions and NO
  categories, and the count returned 0 for "no categories" on the theory that
  such a database was not set up at all. It was set up; it had simply never
  had a pack. Overview and `upgrade -- --check` both said "up to date", and
  `npm run upgrade` installed nothing, because it installs only what this
  counts. Now no categories WITH transactions counts the whole pack
  (pendingPackRules.test.ts); the extra read is paid only in that state.
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
  design (local ran a nightly sync behind until LOCAL IS MIRRORED NIGHTLY), so
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
  SINCE 2026-10-03 `upgrade` ALSO REAPPLIES EVERY RULE AND THE CLOSED BOX on
  every real run, pack or no pack, because that is how stored history reaches
  a box added after it synced. The evidence lives with the closed box in
  money-and-analytics.md ("REACHING STORED ROWS").
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
  SUPERSEDED FOR FRED 2026-10-15, the operator's call: the card renders only
  once FRED is in use (its key set, or a rate stored before), because an
  unused rates index that is no source of transactions is noise on a trust
  page read on a phone. `showsProvider` (`src/lib/ui/providers.ts`) holds the
  rule and its test pins it; every CONNECTOR still renders before it is set
  up. The local-mode sentence still names the FRED call, which is still true
  of what the app can make.
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
  clears it. (Superseded 2026-09-16: it did not — see BACKUP SLOT MOVED PAST
  THE CRON HOUR; the slot is now 00:30 UTC.) Proved the hard way on the day this was written: a backup taken
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

- LOCAL IS MIRRORED NIGHTLY (2026-09-16), superseding "leave it" in the
  backlog. That decision let local run a sync behind on two assumptions: the gap
  stays one night, and a person copies the file down when it matters. Neither
  held. The copies stopped, local fell weeks behind while its file timestamp —
  refreshed every night by the backup's own Setting write — kept looking
  current, and a bug in the cloud's data (the core-position sweep) had no rows
  locally to be reproduced on. So the scheduled backup now finishes by making
  `data/ducat.db` a copy of the file it has just proved equal to the cloud.
  The objection that declined a restore command still stands, so the design
  answers it instead of overriding it: overwriting local "would discard
  anything local-only without being able to tell that it had". Now it can tell.
  After every mirror, local's per-table fingerprint digests are recorded in
  `data/backups/mirror-state.json`, and the next run compares local against them
  first. Any difference means something wrote to local since, and the mirror
  REFUSES, naming the tables, instead of losing that work. Only
  `db:mirror --confirm` — run by a person who has read both digests, the bar the
  declined proposal set — replaces a local that changed, and it keeps the old
  file as `ducat-superseded-…` first. The first mirror needs that confirmation
  too, because nothing yet proves local holds no work of its own.
  ROWS, not the file. A backup is built from the schema and carries no Prisma
  migration history; local does. Swapping files would strip that history, and
  the next `prisma migrate dev` would offer to reset the database. So every table
  is cleared and refilled inside ONE write transaction, fingerprinted INSIDE it,
  and committed only on a match. `clearAndCopy` on its own commits batch by
  batch, which suits a brand-new file and would leave a working database
  half-cleared on a failure. The tests prove both guards by mutation: removing
  the refusal, or running the copy without the transaction, each fails a test.
  Local is written by exactly ONE thing now, a successful mirror. A refused or
  failed mirror leaves it untouched — including the `backup.lastRun` row the
  wrapper used to write regardless, which on its own would make every later
  night look like a local change and refuse forever. The outcome travels in that
  same Setting, so /providers on the phone WARNs on a fresh backup whose mirror
  did not happen: the stale local went unnoticed for weeks precisely because
  nothing said so. The consequence for every data change is to run it against
  the CLOUD only; a local `upgrade`, goal or readiness declaration makes that
  night's mirror refuse until confirmed. A schema change still has to reach
  both databases, because rows only copy into a schema that matches.
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
  raised). Moved to 00:30 UTC on 2026-09-16, below.
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
  asleep at its slot runs the backup on wake (late is always safe; only
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

- BACKUP SLOT MOVED PAST THE CRON HOUR (2026-09-16). The first night the
  mirror ran for real, local came out one sync BEHIND the cloud. Nothing
  failed: the backup copied, verified and mirrored exactly as designed, and
  local matched its backup table for table apart from the `backup.lastRun`
  row written afterwards. The cloud's newest SyncLog said why — the sync
  started at 23:52 UTC, two minutes AFTER the 23:50 backup had copied. Every
  earlier firing that week landed around 23:15.
  The "8-43 minutes late" window was an OBSERVATION over a handful of firings,
  and a slot two minutes past the window's edge was a bet on it. Vercel's
  Hobby cron is documented as firing anywhere within the scheduled hour, and
  this was that: SyncLog cannot tell a late cron from a manual Sync now, but
  the operator confirmed nobody pressed it, so the cron itself fired 52
  minutes late — outside the recorded 8-43 window. The slot must sit after
  the HOUR, not after the observed lateness. It is now 00:30 UTC (20:30 EDT, 19:30 EST — the trigger
  carries a UTC time, so daylight saving cannot pull it back into the hour).
  WHY THE AGE ARITHMETIC DID NOT CHANGE: /providers counts missed nights as
  floor(elapsed / 24h), which only requires every run to stamp minutes after
  its OWN slot. Moving the slot keeps that true; only comments named 23:50.
  RECOVERY that night was the job itself, run by hand once the sync had
  landed: `npm run backup:scheduled` copied the post-sync cloud, verified it,
  mirrored local, and a fingerprint of both databases afterwards matched
  whole-database digest for digest.
  NOT DONE, deliberately: a guard that refuses to call local "in sync" when
  the cloud syncs after the copy. A manual Sync now can land at any hour, so no
  slot makes local current at every instant; what the mirror promises is the
  cloud AS OF its copy, and /providers already names that copy's time.
- A CARD EXPORT'S OWN CATEGORY FILLS IN WHERE NO RULE SPOKE (2026-10-16).
  Chase's card CSV carries a Category column on every purchase, and the
  importer dropped it, so a new user importing a card history had every row
  the rule pack missed land in review, most of them local restaurants. The
  connector now maps the bank's name through the mapping's `categoryMap` into
  `NormalizedTransaction.sourceCategory`, and the sync, after rules, gives a
  fresh row that category when no rule matched, it is not P2P, not a transfer
  and not inside an investment account. It stays an AGGREGATOR category, so
  any rule made or reapplied later still outranks it, and no MANUAL row is in
  reach (a fresh row has none). A mapped name this database holds no
  category for is skipped, not created.
  MEASURED, NOT ASSUMED. Each Chase category was scored against an operator's
  own categories for the same purchases, on the purchases the pack does NOT
  claim, which is where a bank category matters. "Food & Drink" named the
  operator's category every time and is most of a card statement; "Shopping"
  and "Fees & Adjustments" likewise. Left OUT: "Groceries" (a grocery store
  sells a deli lunch, filed as Dining about half the time), "Travel" (Chase
  files transit, parking and rideshare there, which the pack calls
  Transport), "Entertainment", "Personal" and "Bills & Utilities" (mixed), and
  every name not seen on a real export. Imported into an empty database with
  only the pack, a real card export left a small fraction of its rows for
  review that would otherwise have left several times as many, and every
  bank-categorized row that could be matched to the operator's own agreed.
  The dry run counts it through the same function (sourceCategoryToApply),
  pinned by previewImport.test.ts against a real runSync. Other banks' category
  columns (Amex, Capital One, Discover) wait for a real export to measure:
  a map written from a guess at their names is the "assumed" this avoids.
- SYNC SAFETY (2026-10-17, syncSafety.test.ts). Four failures a read-only
  review named and a test reproduced before each fix:
  - TWO RUNS AT ONCE. The feed takes seconds to answer, so the nightly cron
    and a tap on "Sync now" can both be waiting on it, and neither has
    inserted when the other reads what is stored. With the account already
    known, the second insert failed on the (accountId, externalId) unique. On
    a FIRST sync it was worse: both runs created the account, and the same
    real account was stored twice, each copy holding every row, doubling net
    worth. The fix is a lock, not insert-or-ignore: insert-or-ignore cures
    the unique and leaves the forked account. Setting `sync.running` is
    claimed by compare-and-set, the TOTP replay floor's pattern (create, or
    replace only from the exact value read), and carries an expiry, because a
    run the host kills at maxDuration never reaches its `finally`. Five
    minutes, not sixty seconds: a local import:csv or import:pdf runs the
    same pipeline with no limit and must not lose the lock mid-run. The
    refused run throws SyncAlreadyRunningError BEFORE it logs, so health
    never shows a run that never started as one that broke.
  - KILLED BETWEEN THE INSERT AND THE RULES. The rules ran over "fresh" rows
    only, one UPDATE per row, after createMany. A run stopped there (the 60s
    limit, a dropped connection) left its rows stored and uncategorized, and
    the next run's dedupe never called them fresh again, so they stayed that
    way for good. Now the rules run over every WAITING row (AGGREGATOR, no
    category, no transfer pair; MANUAL is never in reach and the write
    repeats the guard), one updateMany per outcome. A row stored earlier
    that the closed box would leave unchanged is skipped as reapplyRules
    skips it; on a backup copy of real data that was every row the wider
    read reached, so the first sync after the change wrote nothing new. A
    row a person CLEARED is AGGREGATOR with no category too, so a rule that
    matches it applies again at the next sync: what clearing already meant
    ("hands the row back to the rules", closedBox.ts), and what creating any
    rule or `npm run upgrade` already did to it.
  - A GAP PAST THE FEED'S REACH. SimpleFIN answers 90 days a request, and a
    longer window (a lapsed token, an instance left off) came back narrowed
    without a word. A connector now declares `maxHistoryDays`; the sync asks
    for no more and records a feed warning naming the dates it could not
    fetch and the CSV import that fills them. The default first-sync window
    and the reach share one clock, or every first sync warns about the few
    milliseconds between two `Date.now()` calls.
  - "SYNC NOW" COULD SPEND THE TOKEN. The bridge disables a token that keeps
    passing 24 requests a day, and a sync costs one or two. Sync now refuses
    from 20 counted today (stored plus this instance's unflushed count),
    which leaves the cron its run; the cron itself is never capped, because
    the data depends on it. Its failures are sentences: a held lock names
    when it lapses, a database refusal goes through databaseFailure
    (actionResult.ts `databaseRefusal`), and a call that never comes back
    (the function stopped at its limit) is caught in the button by
    `settleAction` instead of reaching the page's error boundary.

- CRON HOUR RE-SCORED: 04:00 UTC (2026-10-20). The operator noticed the
  brokerage balance was always a day behind. The feed's publish times had
  moved since the 23:00 choice (the entry above): measured off the stored
  balance-dates over the last thirty nights, the brokerage now publishes its
  close in the EVENING, about 00:35-02:00 UTC (8:35-10pm Eastern), the card
  issuer about 14:15 UTC and the bank about 19:45 UTC. The 23:00 sync (it
  fires 23:08-23:43) ran before the brokerage's close every night, so every
  sync carried the previous evening's. And that evening update values the
  PREVIOUS trading day's close (a Saturday update moved with Friday's
  market, Sunday's and Monday's not at all, Tuesday's with Monday's), the
  one day of lag the entry above calls inherent; so the 23:00 cron showed a
  close two trading days old, and 04:00 shows one. Scored the same way, by the oldest
  institution's balance age when the cron fires: 23:00 averaged 21.3h; 03:00
  14.5h; 04:00 14.7h; 02:00 rejected, firing minutes after the brokerage's
  latest observed publish. 04:00 over 03:00 for the margin rule above: on
  standard time (from November) the same 10pm Eastern publish is 03:00 UTC,
  which a 03:08 firing could miss; 04:00 keeps an hour in both seasons.
  The operator KEEPS the local backup at 00:30 UTC on purpose: it now runs
  before the cron, so each backup and mirror holds the previous night's
  sync, a day behind, accepted. DEPLOY.md registers new installs at 05:30.
  Re-score again whenever a balance reads late: publish times drift.
  Also in that change: vercel.json sets `github.silent`, so Vercel no
  longer posts a bot comment on every pull request (each one emailed the
  operator, as the PR's author). Deploys, their commit statuses and the
  `verify` check are untouched; the preview URL is on the PR's checks.

- SCANNED STATEMENTS, OCR'D OUTSIDE THE IMPORT (2026-10-31). The operator's
  card statements from one bank existed only on paper (mailed; the bank's
  site did not have them), scanned into three image-only PDFs of about a
  hundred pages each, sheets fed in no particular order and a statement's
  pages split across the files. The import refused them as having no text
  layer, by design. The route taken, and why:
  - OCR stays OUTSIDE the import. `npm run pdf:ocr` drives Tesseract and
    Poppler, which the operator installs (winget); the import never calls
    them, never gains a dependency on them, and reads the result as it reads
    any PDF. The parsers' "never OCR" rule is about what a PARSER does with
    a page; the text layer's provenance is the operator's business, and the
    gate is what makes OCR'd text safe to import at all.
  - DESKEW FIRST. A fed sheet sits 1-4 degrees off. Tesseract reads a tilted
    page fine, but it places each WORD at its own baseline, so the line
    reader (SAME_LINE 2pt) split every row into one line per word. A
    projection-profile deskew (the shear that makes the ink's row counts
    peakiest, rotated with sharp) brought rows back onto one line. 300 dpi
    grey beat 400 and 600, and beat every binarisation tried (thresholds,
    normalise, gamma, sharpen): measured by well-formed rows, dates and
    amounts on two row-heavy pages, not by eye.
  - OCR MOVES COLUMNS, NOT JUST CELLS. The amount column is a block of its
    own to Tesseract, with its own baselines: amounts sat 2-3 points off
    their rows on most pages and a WHOLE ROW off on some, so nearest-line
    matching paired them wrong without any sum failing by itself. The layout
    now lifts every amount under the Credits/Charges columns into a stream
    per section and pairs it to the rows by ORDER when the counts agree, by
    nearness (4pt) otherwise; a row left without an amount refuses. The
    payment coupon at the foot of page one prints under the Charges column,
    so the page's table ends at the notice/"Continued"/"Account Number"
    marks or it pollutes the stream.
  - WHAT IS RESOLVED, AND WHAT IS NOT. Inside a cell that can only hold a
    date or an amount, look-alike letters read as digits (O/0, l/1, S/5,
    B/8, Z/2), a lost decimal point is put back (every amount prints cents),
    and a post date with ONE digit wrong is read only where the statement's
    own period leaves exactly one digit possible; a post date beyond that
    gives way to the trans date printed beside it (as Chase's single-date
    layout dates rows); a row between two rows posted the same day takes
    that day (the table lists rows by post date). Nothing else is guessed,
    and every one of these is pinned on invented lines. The residual, said
    in docs/pdf-import.md: a date misread as another valid date inside the
    period passes every check.
  - THE HEADER WORDING CHANGED IN 2024 ("Statement Billing Period" and
    "Account Number Ending in" before, "Statement Period" and "Account
    ending in" after; the older rows print one date column). The first
    grouping pass orphaned every older page-one; the regrouping reads both.
  - OUTCOME on a first pass over a few dozen statements: about half pass
    the gate (some on a card Ducat never had, which --create-account
    answers), the rest are refused with a reason (amounts a scan lost or
    misread, a date OCR could not read, one page with its whole amount
    column illegible at any DPI or contrast, a first page in no scan). A
    cleaner rescan of a refused statement is the fix; the gate makes a bad
    one cost nothing. The masked trace (`parseWellsFargoCard(lines, trace)`) was
    what made each refusal diagnosable without reading a statement: counts
    of rows and amounts per section, the shape of a date it could not read.
  - THE TEXT DRIFTS TOO (found the same night, after the import). The first
    pass stored 37 rows with an EMPTY description: on some pages the
    description block sat two points off its row, and the join only took a
    piece that carried no amount and sat beside the WHOLE row, so a
    description between the dates and an amount on the row's own line, or
    one that drifted together with its amount, was dropped while the row's
    date and amount passed every check. The join now measures "beside"
    against the row's text cells and takes the text out of a piece that
    carries an amount, leaving the amount to the column. The 37 rows are
    refilled by repair:statement-text (sync/statementText.ts), which
    re-reads each file and names every nameless row of the batch that file
    made, by date and amount as a multiset; two different texts for one date
    and amount with fewer nameless rows than texts is left alone. Pinned on
    invented lines, both drift shapes. The layout traces a nameless row as
    it traces an unreadable date, so the next one is seen before it lands.
