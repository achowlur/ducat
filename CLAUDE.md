# Ducat

A personal finance tracker with an insights engine. Local-first by default (runs
entirely on localhost; no financial data leaves the machine), with an OPTIONAL
single-tenant self-hosted cloud deployment (see [DEPLOY.md](DEPLOY.md)).

## This file's contract

Everything here auto-loads into every session, so this file holds RULES ONLY:
each convention is one enforceable line plus a pointer to its evidence file
under docs/conventions/. The evidence — what each rule cost, what was tried
and failed — lives in the pointed file and is REQUIRED READING before changing
anything a rule covers; several record "tried and failed, don't retry". When
adding a convention: rule line here, story there, never both in one place.
The split happened 2026-08-01 at 1,308 lines (~33k tokens per session); every
original word survives verbatim in docs/. Backlog: docs/backlog.md. History:
docs/history.md. User guides: docs/getting-started.md and siblings.

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
- Data locality: LOCAL — transaction data never leaves the machine. Outbound
  calls: the SimpleFIN feed, plus — ONLY when FRED_API_KEY is set — one FRED
  rates GET per sync carrying the key and a series id, never financial data
  (amended 2026-08-02; trust card on /providers). CLOUD — data lives with the
  operator's OWN Turso + Vercel (single-tenant, self-hosted); no third party
  custodies it as a shared service. Opt-in trade-off documented in DEPLOY.md;
  E2E is deferred.

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

## Always-loaded conventions (kept whole — needed every session)

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
- Browsing is limited to the IN-APP browser (`preview_start` /
  `mcp__Claude_Browser__*`), pointed at `<your-deployment>.vercel.app` or localhost.
  Never drive the operator's real Chrome or read their existing tabs and
  sessions, for this or anything else. When something genuinely needs an
  authenticated session the in-app browser does not have — the Vercel
  dashboard, Turso's console — ASK, and never enter credentials anywhere.

## Rules — money & analytics → docs/conventions/money-and-analytics.md

- MANUAL categorization is sacred: any path that rewrites flow or category
  must EXCLUDE manually-categorized rows, as transfer-pair detection does.
- Analyzers legitimately emit NOTHING; every consumer survives an empty
  series — guard the series itself, never assume a page gate covers it.
- Reimbursements push categories NEGATIVE by design: arcs divide by drawable,
  every PRINTED total is net totalSpending (single source:
  ui/spendingBreakdown.ts), and pctDelta is null when EITHER operand crosses
  zero (base ≤ 0 OR current < 0) — /trends names the three refusals in three
  words: new / — / refunded.
- Net worth history requires SNAPSHOTS: investment accounts are known:false
  without a snapshot INSIDE the period; never reconstruct an investment
  balance from transactions, in either direction. Cash/credit are exempt.
- investmentNetFlows counts only money CROSSING the account boundary;
  direction comes from wording, only the magnitude is trusted.
- Never trust one connector's sign convention — investment-amount readers
  must be robust to Fidelity-CSV and SimpleFIN signing the same transfer
  oppositely.
- Anomaly baselines use ACTIVE periods only; anomalies RANK
  (maxPerBaseline: 1) with minPercentile 0.85 as an eligibility gate;
  displayed magnitude is a rank ("higher than N%"), never a ratio.
  Log-space MAD and merchant-history baselines failed — do not retry.
- A coverage gap is TWO claims: a mid-period start is complete data,
  only NO_DATA earns amber, and notices report DOLLARS, not account counts.
- An account covers a period only if its first transaction is at or before
  the period START.
- Reimbursement suggestions lead with AMOUNT evidence; date only breaks
  ties; UNSPLITTABLE categories are denied split evidence.
- A trip/project group (`Transaction.groupLabel`) is a cross-period VIEW
  over real rows, never a re-bucketing: NO analyzer reads it, tagging
  changes no printed total (pinned byte-identical by groupLabel.test.ts),
  and every row-rewriting path — dedup import, reapplyRules, its undo,
  transfer-pair detection — leaves the tag standing, the MANUAL
  protection arriving from the opposite direction.

## Rules — merchants & rules → docs/conventions/merchants-and-rules.md

- Grouped-review keys are ≥3 characters — they become priority-50 CONTAINS
  rules that outrank the pack.
- Anything derived from bank text must stay FINDABLE in it: rules.ts
  collapses whitespace on BOTH sides for CONTAINS/EQUALS; payeeKey TRUNCATES
  at the first noise marker, never deletes mid-string.
- Rules only WRITE — deleting one undoes nothing; any rule-removal path
  needs the reapplyRules/TxnRestore snapshot for undo.
- installRulePack keys on matchField|matchOperator|matchValue: never EDIT a
  shipped rule's matchValue — add the new value at the next priority.
- CONTAINS matches at LETTER boundaries: zero leading letters, exactly one
  trailing letter; digits still decorate. A value that stops mid-word needs
  its full form listed BESIDE it plus a rulePack.test.ts entry;
  npm run rules:audit stays at zero.
- Matcher bugs are found by generated probes and the curated corpus —
  transaction volume cannot find them.
- Rule bands: 1-99 user, 200-299 structural, 500-529 brands, 900-999
  generic, 995 payment rail. Card-payment patterns require a card token AND
  a payment token; short brands are word-bounded regexes, never CONTAINS.
- normalizeMerchant truncates at OBSERVED TRANSACTION_TYPE markers only
  (≥3 chars must precede); adding a marker can WIDEN existing rule
  matchValues — measure what the shortened values newly match first.
- ABBREVIATIONS entries must MEASURABLY split a payee. "fid bkg svc llc"
  now meets the bar; if fixed, the instrument is an expansion, not a marker.
- repair:merchants' description-fallback requires: has a marker, shorter,
  AND a prefix of the stored merchant.
- Processor prefixes strip as a PREFIX only; Toast/Slice/DoorDash also
  auto-categorize via DESCRIPTION rules; after normalizer changes,
  repair:merchants must also rewrite MERCHANT rule values.
- inferAccountType order is load-bearing: deposit words → LOAN before
  CREDIT → card words → investment names → card PRODUCT names LAST.

## Rules — sync & data ops → docs/conventions/sync-and-data-ops.md

- CSV running-balance ties break by FILE POSITION, not date alone.
- SimpleFIN timestamps are deliberately left alone — any "fix" moves
  correct dates too.
- CSV backfill: --external-id targets an existing account, --until stops at
  feed coverage; overlapping rows NEVER dedupe across sources; unroutable
  rows are skipped and reported.
- TWO DATABASES: code ships with git push, DATA does not. Every data change
  runs against BOTH; verify on <your-deployment>.vercel.app; every row-writing
  script prints its database label FIRST — read it.
- Pack drift is counted by pendingPackRules and surfaced on Overview's
  review panel (npm run upgrade); rule changes are never auto-applied.
- SCHEMA is the third upgrade axis: npm run schema:push diffs and only ever
  ADDS; one refusal blocks the whole run; an empty database goes to
  turso:push.
- Whether ADD COLUMN is legal depends on the table having ROWS — the delta
  takes row counts before classifying; Prisma's own diff will DROP what
  schema:push refuses — read its script before running any of it.
- The two databases differ in WHICH ROWS EXIST: before deleting a surface,
  check what the CLOUD has that reaches it.
- Never infer deploy state from the served page or the build id — ask the
  operator to read the Vercel dashboard.
- The cron hour (0 23 * * *) is TUNED to minimise the oldest institution's
  balance age — re-score every candidate hour before moving it. Hobby fires
  8-43 minutes late, never early.
- Provider health derives from LOCAL signals only — no network call on
  launch, ever; staleBalanceDays: 5 is deliberate; a new connector owes a
  trust card in providers.ts.
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
- INVESTMENT accounts are exempt from transaction-gap detection; balance
  staleness covers them.

## Rules — goals, subscriptions & insights → docs/conventions/goals-and-insights.md

- Renewal stepping: clamp to the month's last day and step from the ORIGIN —
  Date.UTC normalises impossible days instead of clamping.
- Subscription charge matching prefers charges NEAR the expected amount;
  detected subscriptions LAPSE after two silent cadence cycles.
- Registered subscriptions fold to charges by their OWN merchantPattern
  (matchesSubscription) — never brandOf; detected wins ties.
- Subscription thresholds are TUNED: run subs:audit before touching one and
  expect the answer no; the audit mirrors the detector's gates — change
  recurring.ts and the audit together.
- Recurring is NOT subscribed: NOT_SUBSCRIPTION_CATEGORIES excludes by
  CATEGORY, not by merchant name.
- "Counts as cash" is a Setting (cash.additionalAccountIds via
  accounts:cash), never an account-type change — retyping breaks net worth.
- npm run goals --add is NOT idempotent (slugs dedupe, content does not):
  read the printed listing before adding.
- The goals panel is gated to the month being lived in; the period selector
  clamps to months with rows PLUS that month (selectPeriod in
  ui/periodNav.ts), so the panel renders from day 1 and its absence means
  the Setting is missing, not the month.
- A cash goal prints its RECONCILIATION beside the projected landing —
  observed cash growth over the same window the rate averages — because the
  rate assumes every saved dollar stays in cash, and with a single goal
  nothing else states that assumption. Never remove it to "declutter".
- House readiness is a READINESS signal, never lender math: the residual
  form (income − non-housing − declared floor) is canonical, non-housing is
  built PER MONTH before averaging, the binding ceiling is named
  FUND-limited (never "deposit-limited"), typed assumptions collapse behind
  ONE tap-to-open ASSUMED disclosure whose summary keeps the rate's as-of
  date visible (a hidden rate must never read current forever), and NO
  default rate lives in code — absent `readiness.house` config, or no
  declared goal to be the fund, means no panel.
- The readiness rate resolves TYPED-FIRST: a typed rate always overrides
  the fetched index; rate-absence is entered only via --fetched-rate; an
  operative fetched rate names FRED and its series in the ASSUMED summary
  and dates itself by the OBSERVATION date; no typed rate + no stored
  observation = no panel, no invented rate.

## Rules — UI & pages → docs/conventions/ui-and-pages.md

- Any axis whose length grows with history thins labels from the END and
  carries a year band.
- Two charts with different ranges: the shorter one names its own range and
  the reason, always.
- /transactions PAGINATES — capping without paging is a data-visibility
  bug this repo shipped twice; every filter-changing link resets page.
- /insights admits the month being LIVED IN before it has rows — and ONLY
  that month — and since 2026-08-02 DEFAULTS to it: every current-gated
  panel (goals, readiness, pace, commitments) lives there, so opening on
  the latest month with rows hid the page's best content every month-start.
  Prior months stay one ‹ away. The empty month says "nothing recorded
  yet", never "nothing needs your attention" — all clear cannot be told
  from not checked. ONE `now` drives both admission and the current-period
  gate, or a render straddling UTC midnight splits them.
- Overview's net-worth HEADLINE is LIVE (the signed sum of account
  balances) and carries NO month label; the MoM delta and market-movement
  lines are context from the latest COMPLETE month's NET_WORTH_GROWTH row
  and carry that month's name, surviving its absence. The spending block
  shows the month being LIVED IN; empty says "nothing recorded yet" plus a
  quiet prior-month link, and every printed total is spendingBreakdown's.
- The ledger's category control is ONE picker in a PORTAL; drive the real
  page after any change to it — its four bugs were invisible in source.
  GroupedReview keeps its <select> deliberately.
- ?category= is an INCLUSION list, written/read ONLY by
  ui/categoryFilter.ts; null means the Uncategorized bucket; the multi-id
  group lives in where.AND; the select needs its synthetic entry.
- ?group= is the trip filter, owned by ui/groupFilter.ts (the payee queue
  is ?payees=1); the group is a scalar equality beside q's OR and the
  category AND; the totals band and the /insights TRIPS rows sum EXACTLY
  what their own filtered view shows — transfers included when tagged,
  and the wording says so; no group touching a period means the section
  is ABSENT, never empty; an untagged row's picker starts with NOTHING
  active, so bare Enter writes nothing; RENAME (the band's control) rewrites
  the WHOLE group, never the filtered view, and renaming onto an existing
  label MERGES — warned before saving, because a merge does not undo by
  renaming back; casing adoption is enforced server-side.
- Charts are hand-rolled SVG; no chart library, no webfonts anywhere (CSP).
  niceTicks guarantees last tick ≥ max; value labels are collision-checked.
- Overview is HEADLINE → DETAIL → TOTAL; the grouping figures are a
  full-width band BELOW the table, never rows inside it; freshness is a
  COLUMN.
- Overview's review panel renders in BOTH states — "all clear" must be
  stated, not implied by absence; the three-level staleness escalation is
  deliberate.
- Per-account "Nd behind" measures against the LAST SYNC, never against now.
- PHONE IS THE PRIMARY READ. Every control clears 44px below md via the
  `.tap44` utility (min-height, never the header's negative-margin pair —
  that overlaps neighbours inside a row); any strip with a hidden scrollbar
  opens at the END the reader needs, not at scrollLeft 0; and the one figure
  a screen exists for never lives in a column that can be scrolled off — the
  ledger's amount moves into the merchant sub-line below md.
- DATES pin to UTC; INSTANTS render local wall-clock plus zone name via
  dateTime(); the zone comes from DUCAT_TIMEZONE, never TZ.

## Rules — performance → docs/conventions/performance.md

- On Turso the COUNT of round trips is the cost, never the size of any one.
- Promise.all buys ~1.13x, not parallelism — buy speed by REMOVING round
  trips; a relation include is one statement each, so select columns.
- Timing claims need counterbalanced ABBA designs running IDENTICAL query
  lists on both arms.
- /api/diag/timing: discard cold samples (msSinceFunctionBoot < ~2000),
  normalize against the trivial queries in the SAME response, and
  sequential.rows is a connection-setup artifact.
- MEASURE TIME ON THE CLOUD, structure on localhost — preview_start prod,
  never npm run dev, for any measurement.
- Page cost is DOM SIZE (parse + hydration), not bytes on the wire.
- Reimbursement candidates travel ON OPEN (suggestCandidates), never
  serialized per ledger row; the collapsed hint and the opened list share
  ONE projection path (makeCandidateFinder) — its wide-pool/narrow-pool
  equivalence is pinned by test and holds under REIMBURSE_POOL_TAKE.
- Analyzer cost is BUCKETING: period bounds memoized, per-period buckets
  computed once — generateInsights runs synchronously inside server actions.

## Rules — security & auth → docs/conventions/security-and-auth.md

- AUTH_PASSWORD_HASH uses a `:` delimiter, never `$` — Next's env loader
  silently mangles `$`.
- Auth fails CLOSED on partial configuration: either variable set counts as
  intent to lock; middleware 503s on intent-without-completion.
- Session tokens carry a DIGEST of the password hash, re-checked per
  request, so a password change evicts sessions.
- Middleware redirects navigations only — the error boundary exists for
  Server Action responses; keep it.
- The dev CSP needs 'unsafe-eval' and the HMR websocket; production gets
  neither — don't "tighten" them away.

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

## Product direction (agreed 2026-07-13)

Distributed software, NOT a hosted service (the Actual Budget model):
each user deploys their own instance (their machine or their cloud) and
brings their own SimpleFIN token (~$15/yr paid by the user to SimpleFIN),
so the maintainer custodies no one's data and aggregator costs stay $0.
CSV import is the zero-dependency fallback. Do NOT build an in-house
aggregator — bank connectivity (not the protocol) is the hard 95% and
there is no free path. "We can't read your data even if breached" (E2E)
is the product's trust story when multi-user matters.
