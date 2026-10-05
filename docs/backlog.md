# Ducat — backlog

> Figures in this file are not real. Those present at publication are scaled by one unrecorded constant, so their ratios are exact; any added since are invented. See [publishing.md](conventions/publishing.md).

OPEN ITEMS ONLY. When an item is built or settled, its entry moves VERBATIM to
[history.md](history.md) ("Built from the backlog") in the same commit, the rule
it produced goes in CLAUDE.md or `.claude/rules/`, and its evidence in
`docs/conventions/`. Cut to open items on 2026-10-04: everything built by then
moved to history.md word for word.

## Where things stand (2026-10-04)

Each item checked against the code after PR #29.

### Corrections: what this file or the evidence files had wrong

- The deeper-history entry said the cron route passes `skipInsights`. No caller
  does; corrected in place below.
- The backfill labour estimate (~8.8 grouped-review decisions per backfilled
  month) was measured before two changes, so it is re-measured with
  `npm run import:csv -- --dry-run` before a backfill is planned. Rows in an
  INVESTMENT account are now TRANSFER by the closed box before any rule runs
  (`src/lib/sync/rules.ts`), so they leave the queue. Unconfirmed P2P rows do
  not, and every date-ordered slice asks about its P2P payees again.
- The database-unreachable copy changed in the em-dash pass (2026-09-22), so
  the byte-for-byte proof recorded below is a proof of the old text.
- Two evidence files still called settled things open: the /accounts
  last-sync line (ui-and-pages.md; fixed 2026-08-06) and the em-dash overload
  in /trends' category table (money-and-analytics.md; the table went in the
  2026-10-03 Trends rebuild). Both now carry a dated note.

### Ready to scope

- **The CSV backfill path** (full entry below): `--skip-insights` for a
  multi-file import; `--until` per account (the connector already takes it per
  account, only `scripts/import-csv.ts` parses one global value); historical
  snapshots from the running-balance column; and a record of which file
  produced which rows.

### Needs a decision before any code

- **A net-worth goal** (full entry below). Its premise improved since it was
  written: the closed box keeps dividends and sales inside an investment
  account out of income, so the cash-flow net and `marketGains`
  (`src/lib/insights/netWorth.ts`) no longer overlap, and saved dollars and
  market movement now split cleanly. The entry's snapshot count ("only seven
  months") is out of date; recount it before the discussion.

### Watching, not work

- **Shattered merchant strings: LEAVE IT** (full entry below). No trigger has
  fired: `TRANSACTION_TYPE` (`src/lib/connectors/normalize.ts`) is unchanged
  since 2026-07-28 and no backfill has run. One thing moved: `merchantKey`
  (`src/lib/ui/merchantLabel.ts`) now feeds /trends' merchant totals and the
  ledger's `?merchant=`, so a label is no longer pure decoration; TRANSFER rows
  count in neither, so the verdict holds.
- **The cloud database-unreachable page, never seen** (full entry below).
  Still waits for a real outage, but no longer needs the operator's own
  credentials: a scratch instance with a throwaway password, the demo's
  precedent, reaches the page.

### Known limits, accepted

Each was decided where it is recorded; listed here so none is rediscovered.

- Every Venmo payee shares the key "venmo payment", so Venmo suggestions are
  weak (merchants-and-rules.md, the P2P entry).
- Annual subscriptions with two occurrences are not detected
  (goals-and-insights.md, recurring detection).
- Retyping an account out of INVESTMENT does not restore a row a CSV import
  flagged TRANSFER by wording (money-and-analytics.md, the closed box).
- A repayment filed under one category but linked to a bill in another
  appears in the first category's ledger view (ui-and-pages.md, repaid).
- Nothing refuses to call local "in sync" after a later cloud sync
  (sync-and-data-ops.md, the backup slot).

## Open items, in full

- **Merchant strings are SHATTERED for internal transfers — RE-MEASURED
  2026-07-31, and the answer is LEAVE IT.** Counts are flat to the row against
  the first measurement: `online transfer` 251 merchant strings / 262 rows,
  `fid bkg` (Fidelity ACH) 27 / 27, `zelle to`+`zelle from` 49 / 49, one
  merchant per row because each carries its own reference code. Two facts
  decide it. First the set is FROZEN: every shattered row is `source=CSV`
  (2024-06-28 → 2026-04-26), and the feed took over on 2026-04-27 supplying a
  clean payee for the IDENTICAL descriptor — "FID BKG SVC LLC  MONEYLINE …"
  stores as "fidelity brokerage services" — so in the feed era only 5 of 238
  distinct merchants exceed 30 characters and this cannot grow on its own.
  Second, STORED is not DISPLAYED: running the real `merchantLabel` over all
  2,677 rows, 391 rows display bank bookkeeping but 136 are TRANSFER and only
  SIX non-TRANSFER rows read badly. Zero Zelle rows are among them — 49 stored
  strings collapse to 75 labels, "zelle to tess on ref # wfct0000000m" renders
  "Zelle To Tess". And the damage is all archive: pages 1-2 of the ledger (the
  newest 200 rows) hold zero shattered rows and zero labels over 40 characters,
  while page 10 holds 57 of 100. Every badly-reading row is dimmed at
  `opacity-60`, renders a plain "transfer" span instead of a category control,
  is excluded from every analytic, and carries its full text in the row
  tooltip — the label is decoration on a row that carries no decision.
  The blast radius was simulated and is CLEAN, which is worth recording because
  it means cost is not what stops this: 438 rows rewritten, 0 of 548 MERCHANT
  rule values shortened (the `wf credit card auto pay` hazard is empty here —
  the rules holding these rows TRANSFER are all DESCRIPTION rules, which
  `repair:merchants` never touches), 0 rows changing category or flow, 341
  grouped-review keys unchanged.
  DO NOT SHIP a third marker `authorized on`. "purchase authorized on macy's
  560 7875 plaza springfield il … card 1234" truncates to "purchase", and
  `MIN_MERCHANT = 3` does not refuse it because 8 characters precede — two rows
  lose their merchant outright (Macy's $418.10 Shopping, Bocaview Optical $101.08
  Health). Wells Fargo puts the merchant AFTER the type in that layout,
  inverting the assumption the whole list is built on. Already pinned by
  `connectors.test.ts:97`.
  `ref #` is also not a one-line addition: `TRANSACTION_TYPE` is `\b(a|b|c)\b`,
  and a `ref\s*#` entry inside that wrapper fires only when the bank omits the
  space after `#` — 31 of 166 Zelle rows against 46 for the unwrapped form, same
  bank, same rail, two behaviours decided by a printed space. Correct is a
  LEADING `\b` only, as `payeeKey`'s `NOISE_MARKERS` already writes it.
  What would flip this, in likelihood order: (1) a CSV backfill — "deeper
  history" is on the backlog and CSV is the only path to it, at ~5.6 shattered
  strings per backfilled month; (2) the feed dropping the payee, which one row
  on 2026-04-27 already hints is not stable (it arrived as "wells fargo" for
  the same descriptor shape) — that would put shattered rows on page 1 within a
  month, and it is the thing to watch; (3) any other reason to restructure
  `TRANSACTION_TYPE`'s regex, in which case `ref #` buys 249 of the 319 labels
  at a measured-zero blast radius and is worth doing opportunistically.
  `moneyline` is not worth it either way — it fixes 27 frozen rows and zero
  future ones, and only ever fires for someone backfilling a Wells Fargo CSV
  that contains a Fidelity ACH.

- **Deeper history.** SimpleFIN caps a request at 90 days (it reports this as a
  feed warning, surfaced on the provider health line). History accumulates
  going forward since syncs never delete; CSV import is the backfill path for
  anything older, and dedups on (accountId, externalId).
  THE PRICE IS REVIEW LABOUR, NOT ROWS — measured 2026-08-08 across the CSV
  era (2024-06-28 → 2026-04-26), so the backfill can be budgeted before the
  exports are pulled rather than discovered halfway through. Shattered merchant
  strings arrive at ~7.5 per backfilled month and the rate is WORST IN THE
  OLDEST MONTHS — ~9.8/month over 2024-07..2025-03 — so a 24-month backfill
  adds ~180 of them at the flat rate and ~235 if it lands entirely in the old
  stretch, against the 173 the entry above counts today: roughly DOUBLING the
  pile, and more than doubling it if the oldest exports are the ones imported.
  That number is also the one that looks alarming and is not. Every such row is
  TRANSFER, dimmed at `opacity-60`, carries no category control and is excluded
  from every analytic, so it costs nothing per row — the shattered-merchants
  entry above measured exactly that and concluded LEAVE IT, and doubling a pile
  whose per-row cost is zero does not change the conclusion. What it changes is
  where those rows sit: they would no longer be archive on page 10, they would
  be most of what a 24-month backfill puts into the ledger.
  THE REAL COST IS GROUPED-REVIEW DECISIONS, at ~8.8 per backfilled month —
  ~210 across 24 months, each one a person reading samples and choosing a
  category, and each one becoming a priority-50 CONTAINS rule that outranks the
  pack. That is the number to plan the labour against, and it is the reason to
  backfill in date-ordered slices rather than in one run: the queue is worked
  by hand and 210 decisions is not one sitting. Note the two per-month figures
  disagree with the ~5.6 the shattered-merchants entry projects; they were
  counted for different purposes and are NOT reconciled here, so plan against
  7.5/9.8 and do not average them.
  WHAT THE IMPORT PATH STILL LACKS, read out of `scripts/import-csv.ts` and
  `src/lib/sync/sync.ts` on 2026-08-08 (the label was added the same day; it
  was the last row-writing script without one):
  - NO DRY RUN — BUILT 2026-08-08, see the verdict below. `runSync` still has
    one mode and it writes: accounts created or updated, balance snapshots,
    `createMany` of the rows, one UPDATE per rule application, two per transfer
    pair, the rate Setting, every insight row for the affected periods,
    `lastSync:CSV`, and a SyncLog row on the failure path as well as the
    success one. Nothing wraps it in a transaction, so an abort halfway leaves
    accounts created and some rows imported — which is why the preview is a
    separate read-only path rather than a flag threaded through the writer.
  - `skipInsights` EXISTS IN `SyncOptions` AND THE CLI CANNOT REACH IT. Its own
    comment names this exact case ("batching several CSV imports"), and
    `sync.ts` claims a batched import "fetches once instead of once per file" —
    true only for a caller that passes the flag, and the only one that does is
    the cron route. A multi-file backfill therefore regenerates every insight
    and spends one FRED GET per file.
    CORRECTED 2026-10-04: no caller passes the flag, the cron route included.
    The route passes `{}` (`src/app/api/cron/sync/route.ts`), and its header
    comment names the flag only as the escape hatch if regeneration ever
    outgrows the function budget.
  - `--until` IS ONE GLOBAL DATE. Feed coverage starts per account, so a
    combined export routed to several accounts takes the same cap for all of
    them: cut early and leave a gap, cut late and duplicate — and overlapping
    rows never dedupe across sources, which is the whole reason the cap exists.
  - `--until` IS ALSO THE BALANCE GUARD, which its name does not say. With the
    cap set, `listAccounts` reports `isStale`, so the import writes no balance
    and no snapshot. WITHOUT it, a mapping carrying a running-balance column
    reports the file's newest row as the CURRENT balance, and `runSync` writes
    it over the live account's — the `foreign` check protects institution, name
    and currency, never the balance, and no date comparison stops it moving
    BACKWARD. A forgotten `--until` on a Chase checking backfill rolls the live
    balance back to the file's last row until the next sync.
  - A BACKFILL PRODUCES NO HISTORICAL SNAPSHOTS, by that same branch. So 24
    months of transactions is not 24 months of net worth: cash and credit
    reconstruct, investment months stay `known:false` until `import:balances`
    supplies month-end values. The running-balance column that could seed them
    is parsed and then used only for the newest row.
  - NO UNDO. CSV ids are content hashes, so a re-download whose description
    text differs by a character re-imports rather than dedupes, and nothing
    records which file produced which rows. Undoing a bad CLOUD import means a
    fresh Turso database and a repointed Vercel — `turso:copy` refuses a
    destination holding transactions — and `db:restore` was declined on purpose
    (see the local-drift entry below). The pre-import backup is the only
    recovery, and it is a manual one.
  VERDICT ON `--dry-run`: BUILD IT — BUILT 2026-08-08 to this bar exactly, and
  what it found while being built (that `--until` is silently the balance
  guard) is in docs/conventions/sync-and-data-ops.md with the rest of the
  evidence. The reasoning is kept because it is what constrains changes to it:
  a read-only BRANCH of the
  path that writes, never a second implementation of the pipeline. It is cheap
  because the uncertain half is already pure and already runs before any write
  — the `CsvConnector` constructor parses, routes, normalizes and hashes in
  memory, `applyRules` and `detectTransferPairs` are pure functions, and dedupe
  is one read query — so a preview can honestly report rows parsed, rows
  skipped as pending, unroutable account values, per-account counts and date
  ranges, what the cap removes, how many rows already exist, what the balance
  write would be, and the two numbers this entry is about: new payee groups and
  new shattered strings. It cannot report what insight regeneration will
  produce and must not pretend to.
  The honest substitute available TODAY is importing against a copy of a
  verified `cloud:backup` and diffing digests, and it is strictly stronger
  evidence — it exercises the real write path. It is also a multi-step manual
  procedure that gets run once, where a dry run gets run before every file, and
  it is a different database than the one that will be written. Do BOTH: the
  dry run per file, the copy-and-diff once before the first real import. The
  argument against building it — new code with no miles on it, landing
  immediately before the import it is meant to protect — is real, and it is
  what the branch-not-reimplementation bar answers.

- **A NET-WORTH GOAL: "reach $X, and when at this rate" — raised 2026-08-04,
  DISCUSS BEFORE BUILDING.** The idea: declare a target net worth and have the
  app say how long it takes at observed growth, the way a savings goal already
  projects a landing month.
  It is not the savings goal with a bigger number, and the difference is the
  whole design question. A cash goal projects from money SAVED — income not
  spent — and the existing panel already prints a reconciliation line beside
  it because even that assumes every saved dollar stays in cash. Net worth
  moves for a second reason the operator does not control: July 2026 alone
  moved the portfolio -$18,935.72 on market movement. A single "growth rate"
  that blends saving with market returns would project a landing date built
  half on a decision and half on a guess, and would read as a promise. The
  engine already keeps these apart on purpose — `marketGains` is reported
  separately from income, `investmentNetFlows` counts only money crossing the
  account boundary, and the readiness panel refuses liquidation-funded
  deposits outright because after-tax proceeds are `known:false`.
  So the open questions, all worth answering before any code: does the
  projection split contributed dollars from market movement and say so, or
  refuse a single rate entirely? What return assumption is honest for the
  market half — and does a TYPED assumption belong behind the same ASSUMED
  disclosure the readiness panel uses, with its as-of date? How much history
  is enough, given net worth needs SNAPSHOTS and only seven months exist, six
  of them partly estimated? What does it print when the rate is negative, or
  when a bad quarter puts the target further away than last month — a goal
  that silently moves its own date is worse than one that refuses?
  Related and already built: `goals-and-insights.md` (cash goals, the
  reconciliation line, house readiness, the typed-first rate resolution) and
  `money-and-analytics.md` (net worth requires snapshots; never reconstruct an
  investment balance from transactions).

- **The cloud-mode DATABASE-UNREACHABLE page has never been SEEN — open, and
  the reason is structural.** The classifier, the copy and the local-mode
  states are all proven (a real unreachable `libsql://` host produced a real
  `DriverAdapterError`, HTTP 404 after 2.2 s with no `code`, classified
  correctly and rendered the cloud text byte for byte; both local states were
  driven in a browser across all six routes). What has never been loaded is the
  cloud PAGE itself, because a `libsql://` URL turns the auth gate on by design
  (`isAuthEnabled()` includes `isCloudMode()`), so the page sits behind a login
  and the database it would report on is the one that is unreachable.
  Closing it needs a human at the keyboard: a scratch instance in cloud mode
  pointed at a dead host, with the operator's own password and code, for one
  screenshot. `.claude/dev-scratch.cmd` carries the line, commented. Nothing
  else is missing, and this is NOT worth manufacturing a session for — record
  it the next time a real outage happens, which is when the state was going to
  earn its keep anyway.
  NOTED 2026-10-04: the cloud copy changed in the em-dash pass (2026-09-22),
  so the byte-for-byte proof above is of the old text; and demo mode showed a
  published throwaway password is a working gate, so a scratch instance no
  longer needs the operator's own password and code.
