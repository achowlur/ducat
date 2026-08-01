# Ducat

A personal finance tracker with an insights engine. Local-first by default (runs
entirely on localhost; no financial data leaves the machine), with an OPTIONAL
single-tenant self-hosted cloud deployment (see [DEPLOY.md](DEPLOY.md)).

## HARD RULES

Absolute (BOTH modes):
- NEVER handle, request, or store bank credentials. Auth happens in the
  aggregator's hosted flow only.
- NEVER hardcode a secret. All secrets via .env (gitignored), the OS keychain,
  or the deployment platform's env-var store.
- NEVER add analytics, telemetry, third-party CDNs, or LLM/AI API calls.
- NEVER write placeholder code or TODOs. Everything committed must run.
- TRANSFER-flagged transactions are EXCLUDED from all spending analytics.

Mode-scoped (`DATABASE_URL` scheme selects the mode):
- Server binding: LOCAL (`file:` URL) binds ONLY to 127.0.0.1 (package.json
  scripts + the middleware host-allowlist). CLOUD (`libsql://` URL) runs on the
  platform host and MUST have the auth gate configured — it fails closed.
- Data locality: LOCAL — transaction data never leaves the machine (the only
  outbound call is the SimpleFIN feed). CLOUD — data lives with the operator's
  OWN Turso + Vercel (single-tenant, self-hosted); no third party custodies it
  as a shared service. Opt-in trade-off documented in DEPLOY.md; E2E is deferred.

## Architecture

connector layer -> normalized schema -> insights engine -> UI

Layers depend downward only. The connector layer normalizes all connector-specific
data into the shapes defined in `src/types/contracts.ts` (`NormalizedAccount`,
`NormalizedTransaction`). Nothing downstream may depend on a connector-specific
shape.

The sync pipeline (`src/lib/sync/`) runs in a fixed order, and the order matters:
upsert accounts → balance snapshots → dedup import → category rules (priority
ascending, first match wins, MANUAL never overridden) → cross-account
transfer-pair detection (exact opposite amounts, ≤4-day window) → insight
regeneration.

## Stack

- Next.js 15 (App Router) + TypeScript strict mode
- Tailwind CSS + shadcn/ui
- Prisma + libSQL adapter — `file:./data/ducat.db` local, `libsql://` Turso in
  cloud mode (one adapter serves both; better-sqlite3 is a devDep for tests only)

## Conventions

- Sign convention (SimpleFIN-style, documented in `src/types/contracts.ts`):
  transaction amounts are signed (positive = INFLOW, negative = OUTFLOW,
  TRANSFER either); balances are signed (CREDIT/LOAN negative), so net worth
  is the plain sum of balances. Insight payloads report positive magnitudes,
  except net worth which stays signed.
- Period keys: `2026-W28` (ISO week) / `2026-07` / `2026-Q3` / `2026`.
- Insight regeneration replaces existing rows per (type, period) but carries
  the `dismissed` flag forward for insights with the same identity
  (see `identityOf` in `src/lib/insights/engine.ts`).
- `BalanceSnapshot` rows are the source of truth for historical balances;
  the engine falls back to reconstructing from transactions (flagged as
  estimated) for accounts/periods without snapshots. Connectors should write
  a snapshot on every sync.
- Commands: see README's table and `package.json`. `npm test` is Vitest.
- VERIFY BEFORE EVERY COMMIT (`/verify`): `npx tsc --noEmit`, `npm run lint`,
  `npm test`, and — for anything that renders — load the affected page in the
  running dev server and read back the actual numbers or measurements. All four
  must pass before `git commit`; a failure is fixed, not committed and noted.
  Never `npm run build` as part of this (see the dev-server rule below).
- NEVER run `npm run build` while the dev server is running — both share
  `.next/`, and the build corrupts the dev server's chunks (symptom:
  "Cannot find module './NNN.js'" and silent hydration failure — no client
  handler works). Fix: stop dev, delete `.next/`, restart.
- After a Prisma migration, RESTART the dev server: the PrismaClient
  global singleton (src/lib/prisma.ts) survives hot-reload with the old
  generated client (symptom: PrismaClientValidationError, "Unknown field"
  for a column that exists).
- `npm run db:seed` DESTROYS every account, transaction, rule and MANUAL
  categorization — it is not an additive command. It now refuses when
  transactions exist unless given `-- --yes` (same guard as `db:reset`). It also
  wipes insights, so re-run `npm run insights:generate` afterwards or pages show
  "no data".
- MANUAL categorization is sacred, and rules are not the only thing that can
  overwrite it. Transfer-pair detection rewrites flow to TRANSFER and nulls the
  category, so it EXCLUDES manually-categorized rows: a $139.95 dinner you
  categorized and a $139.95 repayment two days later look exactly like a transfer
  pair, and the expense would vanish from every spending total. Any future path
  that rewrites flow/category must make the same exclusion.
- Analyzers legitimately emit NOTHING (net worth refuses periods it can't know;
  a CSV-only import writes no BalanceSnapshot at all), so every consumer must
  survive an empty series. `/trends` returned a 500 on first run because
  `NetWorthChart` indexed `months[-1]` and took `Math.max()` of an empty array,
  and the page gated on SPENDING_BY_CATEGORY while net worth comes from a
  different insight type. Guard the series, don't assume the gate covers it.
- Reimbursements can push a category NEGATIVE (deliberate, and tested), and
  three money bugs grew out of that one fact. (1) Shares and arcs divide by
  `drawable`, the categories with net spending — a negative shrinks the
  denominator while drawing no arc, so slices summed past 100% and overlapped.
  (2) Every PRINTED total is the net `totalSpending` that /insights and the
  cash-flow row report; printing `drawable` as the donut headline gave June two
  totals ($3,535.25 on /trends, $3,125.52 on /insights). Both donuts now come
  from `ui/spendingBreakdown.ts` so the two screens cannot drift again.
  (3) `pctDelta` returns null for any base ≤ 0 — a sign flip is not a
  percentage increase, but it rendered as one in the boldest style on the page
  ("Rent & Housing ×13.4", from June's −$409.73 refund). Category lists still
  show negatives honestly; a negative shows "—" for share and vs-prev, while
  "new" keeps its own meaning of no prior row at all.
- A grouped-review key must be at least 3 characters. Keys become priority-50
  CONTAINS rules that outrank the whole pack and are exempt from the P2P guard,
  so a Fidelity dividend on Realty Income (ticker "o") produced MERCHANT
  CONTAINS "o" and recategorized costco, doordash and every Zelle.
- `Date.UTC` NORMALISES an impossible day rather than clamping, so a
  subscription billed on the 31st stepped Jan 31 → "Feb 31" → Mar 3, skipping
  February and drifting further every cycle. Clamp to the month's last day, and
  step from the ORIGIN each time — iterating on the clamped result walks the
  billing day backwards (Feb 28 → Mar 28 when the biller charges the 31st).
- Subscription charge matching is a SUBSTRING, so a $647.93 monitor became "Amazon
  Prime charged $647.93 vs $38.85 expected (+1567%)". Prefer charges near the
  expected amount, falling back to the newest so a real price change still
  surfaces. Detected subscriptions also lapse: the recurring detector has no
  recency bound, so a service cancelled years ago billed forever in the
  annualised total until charges older than two cadence cycles were dropped.
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
- Net worth history requires SNAPSHOTS, not transactions. `balanceAt`
  (insights/netWorth.ts) returns `known:false` for an INVESTMENT account with no
  snapshot at/before the date, and `computeNetWorthGrowth` emits NOTHING for a
  period it can't fully know — a net worth missing an account is not a smaller
  net worth, it's a wrong one. Reason: market movement leaves no transaction and
  every "YOU BOUGHT" is cash leaving with no entry for what it bought, so
  rolling today's balance backward through trades fabricates the past (it once
  reported net worth DECLINING from $707.54k in 2024-06 to $684.22k today, the
  opposite of the truth). Rolling one FORWARD is the same fiction, so a
  snapshot only counts for a period if it falls INSIDE that period
  (`investmentSnapshotNotBefore`) — carrying an August month-end into September
  ignores a month of market movement. Cash/credit are exempt: transactions
  fully explain them. So ONE month-end snapshot per investment account unlocks
  exactly that month; `npm run import:balances -- --template` emits a fill-in
  template for every uncovered month (usage in the script's own header). History
  otherwise grows one snapshot per sync. `marketGains` only computes once two
  consecutive periods are snapshot-backed.
- `investmentNetFlows` counts ONLY money crossing an investment account's
  boundary. Buys, sells, dividends and reinvestments move nothing in or out, and
  counting them turned a real ~$2.5k month into a reported $64.79k one. Classified
  by excluding internal verbs (a small stable set) rather than listing transfer
  descriptors (which vary by institution), so anything unrecognised counts as a
  flow and understates gains rather than inflating them. DIRECTION comes from the
  wording, not the sign: the same monthly transfer arrives +1400 from Fidelity's
  CSV and -1400 from SimpleFIN, so only the magnitude is trusted.
- Sources disagree, so never trust one connector's convention alone. Fidelity's
  CSV and SimpleFIN sign the identical transfer oppositely; SimpleFIN reports
  trades as plain OUTFLOWs while the CSV mapping flags them TRANSFER. Anything
  that reads transaction amounts for an investment account must be robust to
  both.
- Rules match against RAW bank text, so anything derived from it must stay
  findable in it. Two bugs came from ignoring that, both making a rule the user
  had just created silently match nothing: (1) banks pad descriptions into
  fixed columns ("ZELLE TO  RECIPIENT", "WF Credit Card   AUTO PAY") while
  derived payee strings have whitespace collapsed — `rules.ts` collapses BOTH sides
  for CONTAINS/EQUALS (REGEX stays raw); (2) `payeeKey` deleted reference
  numbers mid-string, which only survives when the noise trails at the end as
  it does for Zelle — Venmo puts it between the verb and the name, so the key
  appeared nowhere in the description. It now TRUNCATES at the first noise
  marker, making the key a contiguous prefix by construction (regression-tested
  as an invariant: every derived key must be findable in its own description).
- Anomaly baselines use only periods where the category actually had spending
  (`anomalies.ts`). Counting empty periods as $0 makes the median 0 for any
  category whose data starts partway through history — which, with accounts
  reaching back different distances, was everything — so every ordinary month
  scored as an infinite deviation and reported "vs $0 in a typical month".
  Rent, the most predictable expense there is, was flagged every month.
- Anomalies RANK, they don't threshold. `deviation` decides which one survives
  and the threshold only decides eligibility: `maxPerBaseline: 1` reports the
  most unusual transaction per category (per merchant when uncategorized) per
  period, ties broken on amount because a constant history caps every z at 99.
  Before that the analyzer emitted everything above the line, which on real data
  meant 114 of 132 transaction anomalies were Dining and one month had six
  restaurant meals. The composition was HONEST — 321 of 470 outflows were Dining
  — so no statistic fixed it: higher z, p90, p95 and absolute floors all left
  Dining at 76-86%, and the tighter ones destroyed the findings worth having
  (p95 dropped a $1707.95 one-off; a $100 floor dropped a $95 annual card fee AND a
  $186.6 advisory fee). Also: displayed magnitude is a RANK, not a ratio —
  `percentileOfHistory` renders as "higher than 96% of your Dining" via
  `higherThan()`, rounded DOWN. "4.3× typical" invited reading the median as what
  a dinner costs when 56% of Dining is under $51.83. Tried and failed, don't retry:
  preferring a transaction's own MERCHANT history over its category moved 51 to
  50, because dining spreads across many restaurants and almost none reaches
  five prior visits.
- Anomalies also need a RANK GATE, because a robust z-score assumes ONE
  population and a category can be two. Moving a rent portal's $7.78 convenience
  fee into Rent & Housing left 12 fees beside 11 rents; the median ($170.02)
  described neither, so every rent scored z=36 against a "typical" of $88.95
  and was reported as extraordinary — the exact symptom the active-period
  baseline rule was written to kill, arriving by a different route.
  `minPercentile: 0.85` is an ELIGIBILITY gate and changes no ranking: z still
  picks the winner per baseline, and anything both unusual AND rare is
  untouched. Measured over 2638 real transactions it takes rent from 9 findings
  to 1 — a $4,773.73 payment genuinely higher than 90% of its category — while
  keeping the $1707.95 one-off and the $186.6 advisory fee. 0.9 kills the advisory fee,
  which is why the bar is not higher. It is also self-consistency: the UI prints
  the percentile AS the justification, so a finding reading "higher than 67% of
  your Rent & Housing" was refuting its own headline. Tried and failed first,
  don't retry: LOG-SPACE median/MAD. It is the theoretically appealing fix for
  a heavy-tailed multiplicative quantity, and it destroys the good findings
  before it touches rent — at z>=2.5 rent goes but the $1707.95 one-off and the $186.6
  advisory fee go with it, and at z>=2.0 rent survives all 9 times.
- A coverage gap is TWO claims, not one, and `CoverageNotice` made only the
  harsher one. An account that STARTED MID-PERIOD is in the totals and known to
  the penny — nothing is missing, the period merely is not comparable with
  earlier ones. An account with NO DATA for the period understates it by an
  amount nobody can compute. The first version said "totals here exclude
  <account>", which was FALSE for the first case, and reported a COUNT of
  accounts rather than an amount — so a transit card holding $104.32 of a
  $11,009.59 month raised the same amber banner a missing mortgage would.
  `periodCoverage` now classifies each gap and sums the known contribution;
  only NO_DATA earns amber. Report dollars, not account counts: the magnitude
  is what tells the reader whether to care, and it needs no tuned threshold to
  decide for them.
- Chart axes must survive their own history length. The cash-flow chart printed
  all 26 month labels into a 460px plot — about 17px each where "Jun" needs 26 —
  so they ran together as "JunJulAugSep…", and with no year marker the three
  different Junes were indistinguishable. Labels are thinned to what fits
  (stepping from the END so the newest month is always labelled) and a year
  band with dividers sits beneath. Any axis whose length grows with history
  needs the same treatment.
- Two charts on one page with DIFFERENT ranges read as a bug unless the shorter
  one says why. Net worth spans 7 months against cash flow's 26 because it
  refuses a period it cannot fully know, and the explanation was gated behind
  `netWorth.length < 3` — so at 7 months the reader saw a mismatch and no
  reason. It now names its own range and the comparison whenever it is shorter.
- Data coverage (`src/lib/insights/coverage.ts`): accounts have different
  history depths (a 90-day feed vs an 18-month CSV vs 5 years of brokerage
  history), so periods before an account's first transaction are UNDERSTATED,
  and the month its history starts looks like a spending spike that never
  happened. `periodCoverage` quantifies this and `CoverageNotice`
  surfaces it on Trends/Insights — visibly incomplete beats silently wrong.
  An account counts as covering a period only if its first transaction is at
  or before the period START (mid-period starts are partial).
- `/transactions` is a LEDGER: every row must be reachable, so it PAGINATES
  (`?page=N`, `PAGE_SIZE = 100`, all time newest-first by default). Capping the
  list without paging is a data-visibility bug this codebase has now shipped
  twice — first as "1861 of 2,638 rows were simply unreachable", then again when
  a month default hid 539 rows across 8 months, because 12 of 26 months exceed
  100 transactions (mean 39, median 37, max 135) and month-stepping is not
  pagination. Paging is also CHEAPER than the alternatives: a page is ~100 rows
  of DOM however many years accumulate, and `count` was already being queried,
  so total pages cost nothing. Every filter-changing link resets `page`, or it
  lands on a page that no longer exists.
- In cloud mode a Turso round trip costs ~6ms WARM and 17-58ms while the
  instance is still warming. The "20-25ms MINIMUM" previously recorded here was
  a warming number read as a floor: the zero-row query written down at 34.8ms
  and the 8-row one at 24.7ms both measure ~6ms once hot, because a cold
  invocation inflates EVERY query 3-10x together. Neither number is "the" cost
  and both matter — Hobby has no provisioned concurrency, so real page views
  land on lukewarm instances often and pay the higher one, while anything you
  measure back-to-back pays the lower. What survives unchanged is the
  conclusion: what matters is the NUMBER of round trips, not the size of any of
  them. Cold start is a separate and larger cost again: ~600-800ms of client
  init and TLS lands on whichever query runs first.
- The `Promise.all` on `/transactions` buys about 1.13x, NOT the "six
  concurrent trips cost about the slowest one rather than their sum" this file
  used to claim — that would be nearer 4x. Measured with the ABBA arrangement
  in `/api/diag/timing` (`ordering.concurrentSpeedup`) across seven warm
  samples: 1.63, 1.25, 1.20, 1.15, 0.95, 0.88, 0.87 — mean 1.13, median 1.15,
  individual samples on BOTH sides of 1. libSQL over HTTP overlaps round trips
  only weakly, so concurrency is worth keeping (it is never meaningfully worse)
  while being nowhere near free parallelism. Consequences: a query that GATES
  the others costs about its own round trip, not the loss of parallelism, so
  the old "never add one" is too strong — prefer a filter default that needs no
  database read, but do not contort the page to avoid a gate. And do not try to
  buy speed by adding concurrency; buy it by removing round trips, which is
  what the `include` work above actually did.
- Two things this measurement cost, both worth avoiding again. The endpoint
  compared UNLIKE things for a while: a `replace_all` matched only one of two
  identically-shaped copies of the rows query, so the concurrent group kept an
  `include` the sequential one had dropped — 9 statements against 7 — and every
  number it produced argued for a conclusion that was purely the extra round
  trips. The six queries are now defined ONCE and both arrangements run that
  list, which makes the divergence impossible rather than unlikely. And the
  design was too weak before it was counterbalanced: sequential-then-concurrent
  cannot separate "concurrent is slower" from "whatever runs second is slower",
  and the A-blocks really do differ by position (124.5ms at position 1 against
  66.3ms at position 4 in one sample). ABBA is why the number is trustworthy.
- Reading `/api/diag/timing` correctly, because it is easy to read three
  different numbers off it and believe all of them. `msSinceFunctionBoot` under
  ~2000 means that sample paid a cold start — discard it, or read it as the
  ceiling. Take several samples: absolute ms drift 2x between batches on
  identical code, so normalize the query you care about against the trivial ones
  in the SAME response (`accounts`/`dateRange`/`reviewPool`) rather than
  comparing raw ms across readings. And its `sequential.rows` entry is an
  ARTIFACT, not a query cost — the first database call of a request absorbs
  connection setup. The proof is arithmetic: one response reported `rows` at
  194.1ms and `parallelGroupMs` at 72.7ms, and the parallel group RUNS THAT SAME
  QUERY, so 194.1ms cannot be its intrinsic cost. `sequentialTotalMs` inherits
  the error and is not a real "if these were serialized" figure.
- A relation `include` is a ROUND TRIP — one SQL statement each, confirmed by
  counting Prisma's query log. So `include: { a: true, b: true, c: true }` is
  four statements, and on Turso that is four round trips. Both of
  `/transactions`' big queries were fixed by selecting columns instead:
  - The reimbursement candidate pool (the only query that cannot join the
    `Promise.all`, since its date window comes from the rows already fetched)
    went 41.2ms → ~19ms warm, 5.9x the trivial-query cost down to 2.7x.
  - The row list went from 4 statements to 2 and 32-47ms → 16-24ms warm,
    5.1-7.7x down to 2.5x. `category` was already dead once the category picker
    started taking `categoryId` instead of the object; `account` supplied one
    NAME that the `accounts` array already has. `reimburses` STAYS — it points
    at another transaction, so nothing in memory can answer it.
  Normalize against the trivial queries in the same response when judging any
  of this; raw ms drift 2x between batches.
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
- Two different notions of "the same service" exist and only one is right for
  matching a REGISTERED subscription to a charge. `brandOf` takes the leading
  word, which is correct for folding detector output ("verizon" vs "verizon
  paymentrec urring …") and wrong here: you register "Coursera" and the bank
  writes "coursera.org", sharing no first word. The subscription's own
  `merchantPattern` already decides which transactions are its charges, so it
  is the fold too — `matchesSubscription` in `health/subscriptions.ts`, used by
  `reconcileSubscription` itself so there is one definition. This matters
  because the commitments panel now totals detected and registered together:
  failing to relate them does not merely look untidy, it bills one service
  twice. Detected wins a tie (observed beats asserted) and a registered item is
  marked "declared", because the panel's stated premise is that cadence and
  amount are both observed and that is not true of one you typed in.
- MEASURE TIME ON THE CLOUD, structure on localhost. Localhost has no network,
  no cold start, a `file:` database instead of HTTP round trips to Turso, and a
  desktop CPU instead of a phone — so every TIME number it gives is fiction, and
  three wrong diagnoses in one session came from trusting one. What localhost
  measures correctly is STRUCTURE, which is identical everywhere: DOM node
  counts, how many queries a page issues, uncompressed payload composition,
  whether something is accidentally quadratic. Use `preview_start prod` for
  those (never `npm run dev` — its React SSR reported 870 ms for a page
  production serves in 87 ms). For time, read the deployed app: DevTools →
  Network → Timing gives TTFB and Content Download, and the numbers that matter
  are TTFB (server + round trips) and whatever happens after it (hydration).
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
- Browsing is limited to the IN-APP browser (`preview_start` /
  `mcp__Claude_Browser__*`), pointed at `<your-deployment>.vercel.app` or localhost.
  Never drive the operator's real Chrome or read their existing tabs and
  sessions, for this or anything else. When something genuinely needs an
  authenticated session the in-app browser does not have — the Vercel
  dashboard, Turso's console — ASK, and never enter credentials anywhere.
- Page cost on this app is DOM SIZE, not server time and not bytes on the wire.
  `/transactions` built a 1.1 MB document (952 KB of markup across 300 rows,
  3705 `<option>` elements because every row renders the whole category list)
  against 30-57 KB for every other page. A page is now 402 KB / 1161 options.
  Three wrong diagnoses preceded the right one, all from measuring the wrong
  thing — worth not repeating: (1) the reimbursement hot path (74 inflows × 470
  outflows) is 2.5 ms, so hoisting its projection would have saved 0.6 ms;
  (2) `npm run dev` reported 870 ms for a page production serves in 87 ms, so
  measure with `preview_start prod`, never dev; (3) the document size is NOT a
  transfer cost — Vercel serves `Content-Encoding: br`, and repeated markup is
  what Brotli is best at (292 KB of identical selects compresses 1249× to
  0.2 KB). What a big document actually costs is parse, DOM construction and
  React hydration on the client's CPU, which is why cutting ROWS helped and
  why compressing harder would not have.
- The ledger's category control is ONE picker (`CategoryPicker.tsx`), not one
  per row. A `<select>` per row cost 19 elements (select + 2 optgroups + 16
  options) × 228 rows = 1672, which was 53.4% of the document; rendering the
  list once on demand took `/transactions` from 3132 elements to 1728 and from
  1465 `<option>` to 57. It renders in a PORTAL because the table's
  `overflow-x` container clips the other axis too. Four bugs in it were
  invisible in source and only appeared by driving the real page, so drive it
  after any change: (1) `disabled` cannot hold focus, so disabling the trigger
  during the write blurred to `<body>` and lost your place after every
  categorization — it uses `aria-disabled` plus handler guards; (2) a popover
  that assumes its own height runs off the screen (a 579px list, 275px down an
  800px viewport), so it measures the room and caps `maxHeight`; (3)
  `mouseenter` fires when a popover appears under a STATIONARY cursor, handing
  the keyboard whichever option the mouse sat on — `mousemove` does not;
  (4) the active option starts on the row's CURRENT category and, when
  searching, on the first PREFIX match, because substring search is better than
  native type-ahead ("housing" finds "Rent & Housing") but must not lose it
  ("g" has to mean Gas, not Dining). `GroupedReview` deliberately keeps its
  `<select>`: its choice is STAGED before a write that can rewrite dozens of
  rows, which is a different contract, and it is not on the hot path.
- The `?category=` filter takes a LIST, and `src/lib/ui/categoryFilter.ts` is
  the only place its format is written or read — link builders and the page
  share one encoder/decoder so they cannot drift. It exists because the donut's
  "Other" slice is a SET (everything ranked below `TOP_SLICES`, 8 categories and
  $2005.74 in July 2026) and WHICH categories those are changes every period, so
  a link has to enumerate the ids for the month on screen. The list is an
  INCLUSION list: an exclusion list would silently swallow any category added
  later. `null` in it is the Uncategorized BUCKET, not an absence — which is
  the distinction the donut used to lose, since "Other" and "Uncategorized"
  both carried `categoryId: null` and the href builder skipped the param when
  it was null, so clicking either drilled into the whole ledger instead of the
  slice it had just drawn. Slices now carry `categoryIds`, and `categoryId` is
  gone so the mistake cannot be repeated. Two consequences on the page: the
  multi-id group goes in `where.AND`, because `q` already owns top-level `OR`
  and the two would overwrite each other; and a list matches no `<option>`, so
  the select grows a synthetic "N categories" entry — without it the control
  read "All" while a filter was applied and submitting the form silently
  dropped it.
- Chart discipline (src/components/charts): charts are HAND-ROLLED SVG — no
  chart library, and no webfonts anywhere in the app (both would breach the CSP
  and the no-third-party rule). Axis scales must enclose the data (`niceTicks`
  guarantees last tick ≥ max — regression-tested), and value labels are
  collision-checked against every mark, never drawn over one.
- Analyzer cost is BUCKETING, not arithmetic, and `generateInsights` runs
  synchronously inside server actions — so analyzer time is a hang on a
  dropdown. Period bounds are memoized (`periods.ts`), and anomaly history is
  bucketed once per period with each bucket's median/MAD computed once
  (`anomalies.ts`). Re-deriving either per transaction is what made 10,000
  transactions cost 4.1s instead of 0.15s. Both caches are safe because their
  keys are immutable and both statistics sort, so order in a bucket is
  irrelevant.
- Subscription thresholds are TUNED — `npm run subs:audit` before touching one,
  and expect the answer to be no. The audit reports every merchant with 2+
  charges that was NOT detected, grouped by the gate that rejected it and
  ranked by what it would cost a year if real. On 2638 real transactions, 59 of
  them, and almost every one deserves it: restaurants visited twice, TRC TAPGO
  at a 0.5-day median gap, "zelle transfer" with 1 of 9 gaps regular. Loosening
  any gate floods the list with dining, which is the same failure the anomaly
  pass already worked through. The one honest gap is ANNUAL plans — a $95 card
  fee sits at 2 occurrences because 3 yearly charges need 3 years of history —
  and closing it by admitting 2-occurrence yearlies also admits a tax payment
  and an ice cream shop visited twice a year, so it stays open deliberately.
  The merchant-string-shift blind spot is real but already handled downstream:
  Verizon arrives under three merchant strings and `brandOf` folds them.
  The audit RE-IMPLEMENTS the detector's gates so it can name which one bit, so
  any change to `recurring.ts` has to be mirrored there — it silently kept
  reporting Zego as detected after the category exclusion removed it.
- Recurring is NOT the same as subscribed. `NOT_SUBSCRIPTION_CATEGORIES`
  (`insights/recurring.ts`) drops Rent & Housing and Taxes before grouping:
  they have exactly the shape the detector hunts for — stable descriptor,
  stable amount, monthly cadence — and listing them buries the two or three
  things actually worth cancelling. Excluding by CATEGORY rather than by name
  is what demotes a rent PORTAL without enumerating portals. This reverses the
  earlier decision to ship no rent-portal rules: that objection was that a
  portal bills the convenience FEE for this operator and the whole rent for
  someone else and arithmetic cannot tell which, but that is about what the
  AMOUNT means, not where it belongs — Rent & Housing is correct under both
  readings. A `zego|paylease` rule now ships at priority 250. It does nothing
  for a database that already has user rules at ≤99 pointing elsewhere, which
  is the general lesson: a pack rule cannot fix an instance the operator has
  already hand-tuned, so simulate against the real rule set before assuming a
  pack change lands.
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
- "Counts as cash" is NOT the account type (`ui/liquidity.ts`). A brokerage
  account can hold a money-market balance that is spendable tomorrow, and one
  here does: it grows ~$142.55/month with no transaction behind it, which is
  interest. Retyping it DEPOSITORY is the obvious move and it is WRONG — cash
  and credit are exempt from the snapshot rule in `netWorth.ts` BECAUSE
  transactions fully explain them, and this account's do not, so net worth
  would start reconstructing it from trades and drift. Liquidity and
  market-valuation are two different questions about one account, and the
  override (`Setting` key `cash.additionalAccountIds`, set by
  `npm run accounts:cash`) answers only the first. It is a Setting and not a
  column because it is per-instance operator config and a schema change has to
  be applied to the cloud database by hand.
- `npm run goals -- --add` is NOT idempotent, and the duplicate it makes is
  quiet: slugs dedupe ("house-deposit-2") but CONTENT does not, so re-adding
  an existing goal doubles it and the same dollars count toward both. The
  read-only listing the command prints IS the guard — read it before adding.
  Paid for 2026-08-01: the cloud already held the goal (its data had been
  carried over when the feature shipped), the panel gave no sign of it (next
  bullet), and the re-add created a twin that had to be removed.
- The goals panel is gated to the month being LIVED IN, and the period
  selector clamps to the latest month that HAS insight rows — near a month
  boundary those disagree and the panel is reachable from neither. Verified
  2026-08-01: `?period=2026-08` clamped back to July until the first August
  sync wrote August rows. So a goal declared near the boundary is INVISIBLE on
  the deployment until the new month's first sync, and that absence reads
  exactly like "the data never reached this database" — the misread that
  caused the duplicate above. Check the Setting (`npm run goals` prints it)
  before concluding anything from the panel's absence.
- Overview's shape is HEADLINE → DETAIL → TOTAL, in that order, and the
  grouping figures are NOT table rows. Cash/Investments/Owed shipped first as
  subtotal rows inside the account table and the operator reported them missing
  while looking straight at them: same table, same alignment, a fainter grey,
  so a summary answering a different question read as another account. They are
  now a full-width band BELOW the two-column body, under a heavy rule, because
  a ledger totals at the foot of the column it sums — placed above the accounts
  they read as an interruption of the two things they belong between, and the
  table ended abruptly with no foot. The runway hangs off CASH, being a
  statement about that number and nothing else. Balance freshness likewise gets
  its own COLUMN rather than a badge appended to the account name — a column is
  scannable and is present whether or not anything is late, so the absence of a
  warning is visible too.
- Overview's right column carries SPENDING then NEEDS REVIEW, and the second
  exists because decision 1 gave this page "what needs review" and nothing was
  rendering it. It used to be a red banner in the header shown only when the
  count was non-zero, so a clean instance said NOTHING — and "all clear" cannot
  be told from "not checked" if it is never stated. It renders in both states
  and the quiet one is the point. It also balances the column heights, which is
  the honest fix for the empty right side; enlarging the donut was considered
  and rejected, since a bigger ring is decoration rather than information.
  Uncategorized rows outrank a stale balance in it: they silently understate
  every spending total, where a stale balance is merely old. The same condition
  deliberately appears at three levels of specificity — provider strip, account
  row, review panel — which is escalation, not duplication.
- Overview's per-account "Nd behind" measures the balance against the LAST
  SYNC, not against now. The two failures are different and only one belongs on
  a row: if nothing has synced for a week every balance is a week old, which is
  the sync's problem and the header already says so. What a row can say that
  the header cannot is "the sync ran and this account did not move" — how Chase
  looked while frozen, fresh everywhere else and four days behind there.
  Measured from now instead, it marked 18 of 21 rows the moment local fell two
  days behind, which is noise. The chip at `staleBalanceDays` is the alarm; the
  faint text from `STALE_DISPLAY_DAYS` is legibility only, and the gap between
  them is deliberate — a frozen connection is visible on day 2 and shouted
  about on day 6.
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
- Dates vs INSTANTS are formatted differently and both are deliberate. A
  transaction date, a month label and a projected renewal date are pinned to
  `timeZone: "UTC"`, because the feed mixes noon UTC, 04:00 (midnight Eastern)
  and true instants — re-zoning a date would move correct ones by a day. A real
  instant ("synced …") goes through `dateTime()` in `ui/format.ts`, which renders
  local wall-clock and ALWAYS appends the zone name: without it a UTC timestamp
  reads as local and is silently four or five hours wrong, which is how
  "synced 02:59" was really 10:59pm. Safe because period keys and bounds use
  `Date.UTC`/`getUTC*` exclusively and nothing in `insights/`, `sync/` or
  `health/` touches a local-time accessor, so no display zone can move a month
  boundary. The zone comes from `DUCAT_TIMEZONE` and NOT `TZ`: Vercel refuses
  `TZ` as a reserved variable name, so the standard mechanism is unavailable
  exactly where it is needed. Unset locally, the machine's zone is used.
- `AUTH_PASSWORD_HASH` uses a `:` delimiter, NOT `$`. Next's `.env` loader
  expands `$name` and silently mangles a `$`-delimited hash down to "scrypt", so
  the gate stays up (non-empty) while every login fails. This cost a debugging
  session and appears nowhere else in the repo.
- Auth fails CLOSED on partial configuration. Setting EITHER
  `AUTH_PASSWORD_HASH` or `SESSION_SECRET` counts as intent to lock, and
  middleware turns intent-without-completion into a 503. Requiring both would
  fail OPEN on the likeliest mistake — pasting the hash into `.env` while
  leaving `SESSION_SECRET=""` from `.env.example` — serving everything with no
  login while the operator believes a gate is up.
- Session tokens carry a non-reversible DIGEST of the password hash, re-checked
  per request, so changing the password evicts existing sessions. Without it the
  natural response to "someone has my password" left every session valid for its
  full 30 days. A digest, not the hash — JWT payloads are readable by whoever
  holds the cookie.
- Middleware redirects NAVIGATIONS only, never Server Action responses. A tab
  left open past its session throws instead of redirecting, which is why an
  error boundary exists — without one the whole app drops to Next's bare error
  screen.
- The dev CSP needs `'unsafe-eval'` and a same-origin HMR websocket for Fast
  Refresh. Don't remove them while "tightening" `next.config.ts` — production
  gets neither.
- Rules only ever WRITE, so deleting one does not undo it: every row it
  already categorized keeps that category, and a payee it marked TRANSFER
  stays out of spending. `reapplyRules` therefore returns each row as it was
  (`TxnRestore`), which is what the grouped review's undo writes back. Any
  future "remove this rule" path needs the same snapshot, or it silently
  leaves the rule's effects behind.
- Grouped review keys P2P by a payee string derived from the description, so
  two different recipients stay distinct instead of collapsing into the
  meaningless "zelle transfer" rail. Those rules match DESCRIPTION, which the
  P2P guard permits for user-priority rules.
- Reimbursement suggestions lead with AMOUNT evidence (exact, clean 1/n, or a
  rounded ≈1/n — people send $62.2 for a $61.55 share); date proximity only breaks
  ties. Ranking by date alone put last night's rent above the dinner a $116.63 Zelle
  actually repaid. Categories in `UNSPLITTABLE` are denied split evidence:
  arithmetic can't tell "1/5 of a dinner" from "1/6 of a tax bill".
- `installRulePack` recognizes an already-installed rule by
  `matchField|matchOperator|matchValue`, so EDITING a shipped rule's matchValue
  does not upgrade it — it installs a second rule and leaves the original
  enabled in every database that already ran the pack. Add a new rule at the
  next priority instead (why `901`/`911`/`951` exist beside `900`/`910`/`950`).
- CONTAINS never cuts a word (`containsAtLetterBoundary` in `rules.ts`), and
  the two edges are NOT symmetric. A letter BEFORE the value is always a
  coincidence — no merchant name starts half way through a brand — so
  "star|bucks", "grim|aldi", "gr|uber" and "bomb|shell" are refused
  outright. A letter AFTER is ambiguous, because "trader joe|s" is an
  inflection while "sage|brush" is a different word, so exactly ONE trailing
  letter is allowed: two lets "kohl" claim "kohler", one still reaches the
  "kohls" it was written for. LETTER and not alphanumeric is the whole design —
  banks decorate with DIGITS ("410a hanover food center", "heb #1234",
  "blizzard *us1000000001") and those must keep matching. Why it exists: the
  rule button derives its value from the merchant string, so a short merchant
  became a wildcard, and that failure is SILENT while the opposite one leaves a
  row shouting on Overview. Measured before shipping (`npm run rules:simulate`,
  which keeps both matchers so the comparison never drifts): one real row
  changed and no category moved — Starbucks simply stopped being claimed by
  a user's "bucks" rule — against 1,659 constructed collisions removed across
  579 rule values, and zero losses over 3,292 decorated-merchant probes.
  The consequence for `rulePack.ts`: a value that ENDS MID-WORD no longer
  reaches the longer spelling on its own, so the full form must be listed
  BESIDE it, never instead of it (`installRulePack` keys on matchValue, so
  editing one installs a second rule and leaves the original enabled). That is
  why `exxonmobil`, `amc theatre`, `delta airlines`, `cox communications` and
  `alamo rental` sit next to their truncated forms, pinned by their own describe
  block in `rulePack.test.ts`. Anyone adding a value that stops mid-word owes an
  entry there. `npm run rules:audit` reports any rule still matching mid-word;
  it should stay at zero.
- The pack's OWN corpus tests caught this, not the simulation against 1,030
  real transactions — three of them failed on plurals ("trader joes",
  "jimmy johns") when the rule was still symmetric. Real data cannot find this
  class: it only holds the spellings this operator has actually been billed
  under, and a merchant you have never visited cannot collide with anything.
  More months of the same data would not have helped either, since the
  ten-thousandth transaction is drawn from the same ~515 merchants as the
  first. Generated probes and the curated corpus are the instruments here;
  transaction volume is not one.
- Rule bands in `rulePack.ts`: `1-99` user, `200-299` structural (bank and
  brokerage bookkeeping descriptors — card payments, ATM cash, distributions,
  taxes), `500-529` brands, `900-999` generic words, `995` payment rail.
  Credit-card-payment patterns require a card token AND a payment token,
  because Wells Fargo appends "CARD 1234" to every debit-card purchase and
  matching `card` alone flags half a statement TRANSFER — hiding it from
  spending entirely. The ATM fee pattern is ordered ahead of the ATM
  withdrawal one ("ATM WITHDRAWAL FEE" is a fee, not cash), and short brand
  names are word-bounded regexes, not CONTAINS: "ulta" hides in "consultant",
  "avis" in "Davis", "rei" in "reinvestment", "culver" in "Culver City".
- `normalizeMerchant` also CUTS the bank's bookkeeping columns. A padded
  descriptor is MERCHANT, transaction type, reference, account holder, and
  everything after the type belongs to the bank and varies per charge — which
  shatters one payee into many merchants. Measured on 1018 real rows: "web
  pmts" made 18 distinct merchants out of one rent portal (one per reference
  code), Verizon arrived under three depending on whether the row came from the
  feed (clean payee) or a CSV (no payee at all), and 713 of 1381 merchants ran
  to four words or more. `TRANSACTION_TYPE` is evidence-based and deliberately
  short — every entry was observed — because guessing risks cutting a real name
  in half; `paymentrec urring` is not a typo, Wells Fargo splits "PAYMENT
  RECURRING" across a column boundary. It TRUNCATES, so the result stays a
  contiguous prefix, and it refuses when fewer than 3 characters precede the
  marker so a merchant that IS the marker survives ("Payroll Services Inc").
  Watch one thing when adding a marker: truncation can WIDEN an existing rule's
  matchValue, so check what the shorter value newly matches before applying the
  repair — `wf credit card auto pay` became `wf credit card`, which was safe
  only because it newly matched zero rows.
- `ABBREVIATIONS` (same file) holds exactly one entry, `crd` → `card`, and the
  bar for a second is that it MEASURABLY splits a payee. Chase's descriptor says
  "CHASE CREDIT CRD EPAY" while the feed reports the payee as "Chase Credit
  Card", so 67 rows for one card sat under two names with no prefix relating
  them — which is why the repair's prefix test correctly refused to merge them
  and an explicit expansion was needed instead. It runs BEFORE the truncation so
  an abbreviation next to a marker still expands. "fid bkg svc llc" was left alone on the
  grounds that every source spells it the same way — which is now FALSE for the
  payee and was measured so 2026-07-31: the live feed names it "Fidelity
  Brokerage Services" against the CSV's "fid bkg svc llc", 70 rows to 3. So it
  MEETS this list's own bar (it measurably splits a payee) and an expansion
  would use a name a source really does use. Still unfixed, and if that family
  is ever addressed an `ABBREVIATIONS` entry is the instrument, NOT a
  `moneyline` TRANSACTION_TYPE marker: measured, the marker collapses 27 strings
  to one and STILL leaves the payee split two ways, because `bestMerchant`'s
  prefix test correctly refuses to substitute across the two spellings.
- `repair:merchants` may fall back to the DESCRIPTION, but only when it carries
  a transaction-type marker AND yields a string that is both shorter than the
  stored merchant and a PREFIX of it. The prefix half is load-bearing and was
  added after a dry run caught the length-only version rewriting a clean "chase
  credit card" into the bank's own "chase credit crd" — one character shorter
  and plainly worse. Needed because a connector sometimes supplies a payee the
  bank already mangled ("HarborwayMgmt WEB BQXRT"), so the marker is not in the
  stored string and re-normalizing it is a no-op by construction.
- `normalizeMerchant` strips payment-processor prefixes (`tst*`, `sq *`,
  `slice*`, `dd *`, `py *`, `spo*`, `gdp*`, `fiv*`, `uep*`, `pl*`, `cl *`,
  `wl *`) so the real merchant is reachable by brand rules and groups by
  itself. The leading `\b` is what keeps "DD'S DISCOUNTS" intact, and
  stripping a PREFIX (not a middle) is what keeps the result a contiguous run
  of the original — the same property `payeeKey` needs. Only Toast, Slice and
  DoorDash also auto-categorize, via DESCRIPTION rules since the raw
  description keeps the prefix; Square and the rest bill salons and retail, so
  they get the strip and no category. Normalization runs at IMPORT, so
  `npm run repair:merchants` re-normalizes stored rows — and MERCHANT rule
  values too, or every rule still carrying a prefix silently stops matching.
- `inferAccountType` order is load-bearing: deposit words first (so "Platinum
  Savings" and "Investor Checking" at a broker stay DEPOSITORY), then LOAN
  before CREDIT (so "line of credit" is a loan), then card words, then
  investment names, and card PRODUCT names LAST — "gold" and "platinum" are
  fund names too. Without the product list "Chase Sapphire Preferred" carried
  no card word at all and counted as an asset.

## Verified load-bearing (three reviews, 2026-07-26) — do not "clean up"

Re-checked against current code by an independent reviewer and deliberately
left alone: the merchant-string reducers (`normalizeMerchant`, `payeeKey`'s
truncate-not-delete, `collapse` in `rules.ts`, `brandOf`); the account-lookup
fallback vs `matchAccount`; the MANUAL exclusions in `sync.ts` and `rules.ts`;
the `known:false` / `investmentSnapshotNotBefore` contract; the "only active
periods" anomaly baseline; and the
`internalActivity`/`inboundWording`/`outboundWording` triple. On the UI side:
`/providers`, the coverage notices, refusing to draw net worth it can't know,
the reimbursements-exceeded empty state, the grouped-review P2P tooltip, the
money typography, and Overview's market-movement line.

## Backlog (agreed 2026-07-27, investigated, not yet built)

**Rebuild /insights as "am I on track?" — DESIGNED 2026-07-27, BUILT 2026-07-28.**
All four slots ship (`insights/digest.ts`, `insights/pace.ts`,
`health/commitments.ts`) and decision 1 is implemented: Overview carries state
only. The design below is kept because it is what constrains changes to it.
The diagnosis first, because it is not what it looks like: the
analyzers are fine. They are the most hardened code in the repo. The problem is
that the TAB HAS NO EXCLUSIVE CONTENT — every insight type it renders has a
better home elsewhere (SPENDING_BY_CATEGORY and CASH_FLOW_TREND on /trends,
NET_WORTH_GROWTH on /trends and Overview, RECURRING_CHARGE on Overview with its
annualised total, ANOMALY on Overview's signals). And `GROUPS` is keyed by
`InsightType`, so it is organised around the ENGINE'S DATA MODEL rather than a
question anyone asks. Every other tab answers something a person wants — how am
I doing / how has this changed / what exactly happened / what do I have / can I
trust this — and this one answers "what did the engine compute".

Also settled: the "Ducat observes, it doesn't model" framing is WRONG and
should not be repeated. The app already models and already projects —
`annualisedTotal` is a forecast, `isActive` predicts a charge that didn't
happen, renewal dates are stepped forward, anomalies are median/MAD inference,
`marketGains` is attribution. The principle it actually holds is narrower:
NEVER ASSERT WHAT THE EVIDENCE CANNOT SUPPORT, REFUSE RATHER THAN FABRICATE
(`known:false`, active-period-only baselines, `pctDelta` null on a base ≤ 0).
That permits projection and constrains it — and the lapse bound proves the
point: when `annualisedTotal` billed a cancelled Netflix forever, the fix was
to bound the projection by evidence, not to stop projecting.

The design, so it is not re-derived:

- **One question: "am I on track, and what needs attention?"** Backward and
  forward are not two sections stacked — THE FORWARD CLAUSE IS WHAT EARNS A
  CHANGE ITS PLACE. "Dining up 34%" is a number; "up 34%, third month rising,
  ~$2,850.9/yr if it holds" is a decision. Anything that cannot state a forward
  consequence probably does not belong, which is also the filter that stops
  this becoming noise.
- **Four slots, each refusing independently.** (A) where this month lands —
  spent so far, still committed, what comparable months ran, on pace for.
  (B) what changed, ranked across types, each with its consequence. (C) what is
  already committed in the next 30 days, with dates. (D) "nothing needs
  attention this month", explicitly and often.
- **Rank slot B by DOLLARS AT STAKE over the next twelve months, not by
  statistical unusualness**, with deviation only as a tiebreak. A 4x deviation
  on a $31.1 charge matters less than a 3% drift on rent. This makes the
  projection do work rather than decorate, and attacks the Dining-flood problem
  from a different angle than the anomaly analyzer does.
- **Refusals, reusing what exists:** no pace call before ~25% of the period has
  elapsed (day 3 says nothing); only periods where the category was actually
  active (the anomaly baseline rule); and nothing projected across a period
  `periodCoverage` knows was incomplete. Projections get their own chip and
  explicit wording — the moment a forecast reads like an observation the app is
  asserting what it does not know.
- **Historical periods show the projection BESIDE what happened** — "June: on
  pace for $9,589.4 on day 18, landed at $9,392.43". That makes the forecast
  accountable instead of decorative, is the falsifiability test made visible,
  and gives the existing period selector a real job.

Three decisions, agreed:
1. **Overview narrows to STATE** (balances, net worth, what needs review);
   /insights owns TRAJECTORY. Without this the two tabs answer the same
   question again, which is how the current overlap happened. DONE 2026-07-28 —
   the signals column, the subscriptions block and the price-drift/renewal
   chips are gone, and Overview dropped a query with them.
2. **Slot B is hard-capped at 3-4 items**, as a rule and not a default —
   `maxPerBaseline: 1` is the precedent.
3. **"On pace" compares to the SAME CALENDAR MONTH in prior years**, falling
   back to a trailing average when there are too few. They disagree for
   anything seasonal, and rent-dominated months make a trailing average look
   stable while a December genuinely is not.

Architecture: DO NOT STORE the digest — rank at render from stored insights
plus one new forward analyzer. `generateInsights` runs synchronously inside
server actions (the 4.1s lesson), so the digest must not add a pass; reuse the
memoized period bounds and the anomaly analyzer's per-period category buckets.

**Build C FIRST, then A, then B.** C is the forward-commitment number, and the
hard part is already written and correct: `stepForward`/`addMonths` in
`health/subscriptions.ts` already project a next-due date with month-end
clamping, stepping from the ORIGIN so clamps never accumulate. The work is
applying that to DETECTED charges, which today carry only `lastDate` and
`cadence`. It is also the highest-confidence projection the app will ever make
— observed cadence, observed amount, no assumption — which makes it the right
place to establish how projections are chipped, worded and refused before doing
it anywhere riskier. A needs C for its "still committed" clause; B needs both
for its forward-impact ranking and is the highest noise risk, so it goes last,
after decision 1 is implemented.

Five items raised after the cloud deploy, with what investigating them already
turned up so it isn't rediscovered:

- **`/transactions` is 10× slower than every other page** — 0.87s against a
  local FILE database, where `/`, `/trends`, `/insights`, `/accounts` and
  `/providers` are all 0.06–0.09s. Cause located: in `transactions/page.tsx`
  the `candidatePool.map(...)` sits INSIDE `candidatesFor`, which is called per
  inflow row, so 74 inflows × 470 outflows = 34,780 projections per load. Same
  bug class the analyzer pass fixed, hiding in a page component. Cheap fix is
  hoisting the map; the bigger one is computing candidates lazily, since all 74
  are currently computed AND serialized into the HTML even when none is opened.
  Measure in a PRODUCTION build before judging — 0.87s is a dev-mode number.
- ~~Donut navigation~~ — DONE, see the category-filter convention above.
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
- ~~Another pass on subscription detection~~ — AUDITED, and the answer is
  DON'T. See the recurring-detection convention above.
- **A public demo instance** — DESIGN AGREED 2026-07-27, DEFERRED on purpose.
  Not blocked on anything technical any more; it waits until the app is
  feature-stable, because a demo built against a moving app is a second thing
  to keep in sync and every screen change would have to land twice. Build it
  when the surface stops moving. The design, so it is not re-derived:
  - **Published password, NOT a login-less demo.** The mode-scoped HARD RULE
    requires the auth gate to be CONFIGURED; it says nothing about the password
    being secret. So the demo sets `AUTH_PASSWORD_HASH`/`SESSION_SECRET`
    normally and prints the password on the login page. This needs NO amendment
    to the rule and — the real reason — NO change to `middleware.ts`,
    `mode.ts` or `session.ts`, so a demo bypass that could ever be set on the
    operator's own instance never exists. It also keeps crawlers from indexing
    fabricated financial data, and the login page is the natural place to say
    the data is invented.
  - **Mutable, with a daily reset**, reversing the earlier "genuinely
    read-only" position. What changed: there is no free-text persistence path.
    Categories cannot be created from the UI and rule values derive from
    existing merchant strings, and rule `matchValue` is not rendered anywhere,
    so the worst a visitor can do — POSTing `createRuleFromMerchant("a", …)`
    straight at the server action — is make the demo look wrong until it
    resets. Vandalism is recoverable; offensive content shown to the next
    visitor would not have been. Read-only would also have hidden the best
    parts of the app, which are all mutations (category picker, grouped review,
    reimbursement linking). If it is ever made read-only after all, layer it: a
    read-only Turso token is the actual guarantee, and a write guard on the
    Prisma client is the decent error message — never per-action guards, which
    would be forgotten among 11 server actions.
  - **Two years of history**, ~800-3888 transactions plus ~130 snapshots.
  - The decisive constraint is that demo data DECAYS. Subscriptions vanish once
    `isActive` sees them lapse, "this month" empties at the month boundary, and
    net worth draws nothing without a snapshot INSIDE each period per
    investment account. So fixtures must be generated RELATIVE to today and
    regenerated on a schedule — which means the reset job is required whether
    or not the demo is mutable, and is what makes mutability nearly free.
  - Its own Vercel project and Turso database, no `SIMPLEFIN_ACCESS_URL`, and
    it should REFUSE TO BOOT if that variable is set — the same fail-closed
    idiom as the auth gate. Verified that no UI path accepts a SimpleFIN token;
    the access URL is env-only, so the credential HARD RULE is safe by
    construction.
  - Rejected: a "try it" that shows optimistic UI and never persists. That is
    hidden-not-blocked, and it lies to the visitor.
  - The rule most likely to be broken LATER is the analytics one. A demo invites
    "how many people tried it?" — the answer stays no.

## Backlog (agreed, not yet scheduled)

- **Savings goals on /insights — BUILT 2026-07-31.** The design below is what
  shipped, kept because it constrains changes to it.
  The shape is a declared target with a horizon — "House deposit, $155,503.76 by
  Jun 2028" — shown against the observed savings rate: saved so far, rate, the
  date it lands, and how that compares to the target date. It reuses
  `CASH_FLOW_TREND` for the rate and the `computeRunway` arithmetic in
  `ui/liquidity.ts` (a test pins the two windows equal), and it inherits the
  same refusals — too few complete months, or a savings rate at or below zero,
  and it says so rather than printing a fantasy date. Chipped `PROJECTED` like
  every other forecast.
  What was REJECTED, and why, because it is the obvious thing to ask for next:
  PER-CATEGORY MONTHLY BUDGETS. The pace call already answers "am I spending
  more than usual" from the operator's own history and needs no configuration,
  so a budget replaces observed evidence with a typed number — less evidence,
  not more. And twelve categories times every month is a wall of red that
  trains the reader to ignore it, which is the same flooding failure the
  anomaly pass spent real effort escaping. A savings goal is different in kind:
  the app cannot infer a house deposit target, so declaring it adds information
  the data does not contain. That is the test for whether something earns
  configuration.
  Both open decisions settled at build time. (1) "Saved" is a NOMINATED SET OF
  ACCOUNTS, declared per goal: cash as a whole breathes by a rent cycle and
  counts the emergency fund toward the house; net worth drags in market noise
  and the snapshot machinery. Declarations live in the `Setting` key
  `goals.savings` (`npm run goals`, same needle-resolution as `accounts:cash`),
  so a goal is a DATA change run once per database and no schema touched
  either one. The RATE stays the app-wide `CASH_FLOW_TREND` net — transfers
  are excluded from cash flow, so moving money INTO the fund cannot inflate
  the rate that projects it; the projection therefore assumes future net
  savings reach the fund, and when two goals both project, the panel says the
  shared-rate assumption out loud once. (2) A slipping goal does NOT reach
  Overview — Overview carries state and just shed its projections; the panel
  renders on /insights only, gated to the month being lived in like pace and
  commitments, since saved and the rate are measured from now. The analyzer is
  a pure function over plain arrays (`insights/goals.ts`); a reached goal is a
  fact and refuses nothing, and every refusal keeps the facts either side of
  it — saved, target, and the negative rate that IS the reason there is no
  date.
  A declaration HELPER was added 2026-08-01: `--house-price` (with `--down`
  and `--closing`, defaulting 20 and 3) derives the target as CASH NEEDED —
  (down% + closing%) × price — prints the arithmetic, and stores only the
  resulting number. The derivation is evaluated once at declaration, in front
  of the operator, and never re-runs at render; a bare "30% of the house" was
  rejected as a stored formula because the percentage is market- and
  loan-product-specific, but survives as roughly what down+closing+buffer
  totals, which is why 20+3 are the visible defaults rather than a constant
  buried in code.

- **House-readiness model — DESIGNED 2026-08-01, NOT BUILT.** Answers "am I
  close enough to start looking?" — a READINESS signal, explicitly NOT lender
  math: whether underwriting would approve is a question the model
  deliberately does not answer, like the tax cost of liquidation below.
  REJECTED first, so they are not re-proposed: gross-income DTI (28/36) —
  bank inflows are net of tax/401k, so observed data is the wrong shape for
  lender rules and the right shape for something better; and
  mortgage-as-share-of-observed-SPENDING — the denominator is the thing the
  operator controls, so it punishes frugality (measured: 35% of July's $11,058.91
  spending is $3,872.04, BELOW the $4,662.52 rent already carried in a month that
  netted +$3,104.89).
  The canonical form is the RESIDUAL:
  PITI budget = observed net income − observed non-housing spending − declared
  savings floor, all over the same 6-complete-month window runway and goals
  use. Non-housing = total spending minus Rent & Housing PER MONTH, then
  averaged — which makes the form REFUND-PROOF: June 2026's Rent & Housing is
  −$401.85 (a reimbursement month), which distorts any "rent + savings rate"
  form and cancels out of this one. That is why the residual form is canonical
  and the rent+rate form is only a derived identity.
  One declared knob: the savings floor — how much monthly saving must survive
  the purchase — operator-set at $5,183.46/mo, stored as a Setting beside the
  goal. Typed assumptions, each rendered with its value and chipped ASSUMED:
  rate and term (typed, shown with its as-of date — the fetcher above is the
  opt-in follow-on; never bake a default rate into code), property tax and
  insurance as %/yr of price, PMI below 20% down, closing as % of price paid
  from cash.
  Outputs are TWO price ceilings with the binding one NAMED: fund-limited
  (the no-PMI path — the fund covers down + closing) and payment-limited (the
  amortization back-out, PMI included below 20% down). Worked at design time:
  PITI budget $6,465.61/mo; the $156k target buys ~$676k conventional with
  ~$2,100/mo of payment slack, ~$880k stretching through PMI; balancing the two
  constraints wants ~$230k cash for ~$999k of house. The fund-limited ceiling
  moves NOT AT ALL with the rate, so a live rate feed refines the non-binding
  side — a polish, not a prerequisite.
  Constraint wording is FUND-LIMITED, never "deposit-limited": the binding
  constraint is the DECLARED FUND, and phrasing it as incapacity is factually
  wrong for an operator holding a taxable brokerage that could fund a deposit
  tomorrow. The model measures readiness OF THE DECLARED PLAN — that scoping
  is what keeps the signal from reading "reached" at declaration for anyone
  with a portfolio. LIQUIDATION-FUNDED deposits are out of scope with the
  reason recorded: SimpleFIN supplies balances and transactions, not lots or
  cost basis, so after-tax proceeds of a share sale are `known:false` and a
  printed number would be fabricated; and whether to de-risk equities for a
  house is a portfolio decision, not arithmetic. Supporting observed fact:
  July 2026 alone moved the portfolio −$18,935.72 on market movement, which is
  why money with a closing date migrates to cash-like instruments. The
  VERIFIED transfer picture (2026-08-01 — the first draft of this entry got
  the destination wrong, caught by recomputing against the database): the
  fund was seeded ONCE, $51,355.89 into TOD (0006) on 2026-01-12, and has
  grown only by money-market dividends since (~$142.55/mo, matching the
  counts-as-cash convention above); every one of the fourteen standing
  $3,628.42/mo transfers lands in the OTHER Individual account (0001), the
  actively-invested one. So the DECLARED FUND currently receives no ongoing
  contributions, and the goal's landing date leans entirely on the panel's
  stated assumption that future net savings reach the fund — an assumption
  today's transfer history contradicts. The transfers are TRANSFER-flagged on
  both sides, so counting them as saving would double-count (the rate already
  contains them as income-not-spent).
  Refusals inherited whole: fewer than 3 complete months; floor at or above
  income minus non-housing (the budget is ≤ 0 and it says so, naming the
  floor as the reason); nothing computed across coverage-incomplete periods.

- **P2P review, still open:** (c) recurring-pattern detection on P2P (same
  payee, same amount, monthly) to pre-fill rule suggestions; (d) an explicit
  "P2P — Unreviewed" bucket so analytics are visibly-incomplete rather than
  silently wrong while the pile shrinks. (Bulk grouping-by-payee and
  reimbursement auto-suggest are both DONE — see Conventions.)
- **Deeper history.** SimpleFIN caps a request at 90 days (it reports this as a
  feed warning, surfaced on the provider health line). History accumulates
  going forward since syncs never delete; CSV import is the backfill path for
  anything older, and dedups on (accountId, externalId).

## Shipping to other people (SHIPPED 2026-07-26)

All four items are built; the details that constrain future changes are in
Conventions above. The pack went from 160 rules to 421 and from 12 categories
to 15, so a fresh clone now starts with the structural rules, the processor
prefixes, the chain list and the account-type inference that previously existed
only in the operator's hand-tuned database.

Two facts worth keeping. First, the pack is now large enough that its own
consistency needs testing, not just its output — `rulePack.test.ts` asserts no
value is listed twice (installRulePack dedupes against a DATABASE, not against
the pack) and that every rule points at a category the pack installs. Second,
this changed almost nothing for the operator: simulating the new pack against
2638 real transactions rewrote 80 rows, all of them `categorySource`
AGGREGATOR → RULE on credit-card payments already flagged TRANSFER by pair
detection. No category moved and no total changed, because ~160 user rules at
priority ≤50 outrank the whole pack — which is the intended relationship. The
value is entirely for the next person to clone it.

What deliberately did NOT ship: rent-portal rules (PayLease and Zego billed the
operator's convenience FEE, not the rent, and arithmetic can't tell which is
which), and anything institution-specific like a brokerage's own ACH
descriptor. Those stay the grouped review's job.

## Build order and status

The order was deliberate and still constrains changes. Contracts came first
(`src/types/contracts.ts`) so nothing downstream could depend on a connector
shape. The insights engine was built and tested against FIXTURE data before any
connector existed — which is why the five analyzers in `src/lib/insights/` are
pure functions over plain arrays, the property that makes browser-side E2E
viable later. Connectors then normalized into contracts the engine already
consumed (`src/lib/connectors/`, `src/lib/sync/`), and provider health plus
subscription tracking (`src/lib/health/`) followed because real syncs could now
fail. The six UI tabs (`src/app/`) came last, over an engine already producing
typed insights. Security hardening came AFTER the surface existed — an audit of
a finished attack surface, not a guess at one — converting "nothing leaves the
machine" from developer discipline into enforced controls (`next.config.ts`,
`src/middleware.ts`). Cloud mode (`src/lib/auth/`, `vercel.json`) amended the
localhost HARD RULE only once local was proven.

Ducat has been exercised on four figures of real transactions across multiple
real accounts and years of history, not just fixtures. Most of Conventions above
exists because real money surfaced what seeded data could not — CSV mappings that
were wrong against actual bank exports, and net worth and anomaly analytics that
were both fabricating results at scale. Two adversarial QA passes then found what
even real data hadn't: a first-run crash, a destructive command with no prompt,
and several silent money errors. The lesson worth carrying: **most of these were
invisible to tests and to normal use — they needed someone deliberately asking
"what would break this?"**

**Session 9 — Cloud deployment (DONE 2026-07-26).** Live at
`https://<your-deployment>.vercel.app`, Turso database `ducat` in `aws-us-east-1`
(paired with Vercel's `iad1`: every route is server-rendered on demand, so each
page view is several function→database round trips). Verified from outside —
every page 307s to /login, the cron 401s without a token and with a wrong one,
CSP/HSTS and four more headers present, and production correctly lacks the
dev-only `'unsafe-eval'`. Login and data rendering confirmed on a phone.

Four things the runbook was wrong or silent about, all now fixed in DEPLOY.md
and worth not relearning: npm's banner ended up inside `baseline.sql` and
killed the very first command; the baseline creates tables but no rows, so the
instance came up with zero categories until step 3 was added; the Turso CLI
ships Darwin/Linux assets only, so Windows needs the dashboard plus
`npm run turso:push` (which refuses a non-empty database); and step 4's
generators print `.env` LINES, so pasting them into Vercel's form buries quotes
inside the secret and login fails with nothing on screen to say why.

The cloud database now holds the full copy: `/api/diag/timing` reports 2638
transactions across 21 accounts and 15 categories, matching local. Its review
pool is empty (0 uncategorized non-transfer rows), so the P2P backlog went over
with everything else.

## Product direction (agreed 2026-07-13)

Distributed software, NOT a hosted service (the Actual Budget model):
each user deploys their own instance (their machine or their cloud) and
brings their own SimpleFIN token (~$15/yr paid by the user to SimpleFIN),
so the maintainer custodies no one's data and aggregator costs stay $0.
CSV import is the zero-dependency fallback. Do NOT build an in-house
aggregator — bank connectivity (not the protocol) is the hard 95% and
there is no free path. "We can't read your data even if breached" (E2E)
is the product's trust story when multi-user matters.
