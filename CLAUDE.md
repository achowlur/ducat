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
- Prisma + libSQL adapter — `file:./data/finance.db` local, `libsql://` Turso in
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
  fixed columns ("ZELLE TO  LENA", "WF Credit Card   AUTO PAY") while derived
  payee strings have whitespace collapsed — `rules.ts` now collapses BOTH sides
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
- Data coverage (`src/lib/insights/coverage.ts`): accounts have different
  history depths (a 90-day feed vs an 18-month CSV vs 5 years of brokerage
  history), so periods before an account's first transaction are UNDERSTATED,
  and the month its history starts looks like a spending spike that never
  happened. `periodCoverage` quantifies this and `CoverageNotice`
  surfaces it on Trends/Insights — visibly incomplete beats silently wrong.
  An account counts as covering a period only if its first transaction is at
  or before the period START (mid-period starts are partial).
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
- Provider health (`src/lib/health/`) derives status from LOCAL signals ONLY —
  last sync outcome, feed errors, stale balance dates, transaction-volume gaps.
  No network call on launch, ever. Adding a connector also means adding its
  trust card in `providers.ts`.
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
  "zelle to lena" and "zelle to hollis amari" stay distinct instead of collapsing
  into the meaningless "zelle transfer" rail. Those rules match DESCRIPTION,
  which the P2P guard permits for user-priority rules.
- Reimbursement suggestions lead with AMOUNT evidence (exact, clean 1/n, or a
  rounded ≈1/n — people send $62.2 for a $61.55 share); date proximity only breaks
  ties. Ranking by date alone put last night's rent above the dinner a $116.63 Zelle
  actually repaid. Categories in `UNSPLITTABLE` are denied split evidence:
  arithmetic can't tell "1/5 of a dinner" from "1/6 of a tax bill".

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

## Backlog (agreed, not yet scheduled)

- **P2P review, still open:** (c) recurring-pattern detection on P2P (same
  payee, same amount, monthly) to pre-fill rule suggestions; (d) an explicit
  "P2P — Unreviewed" bucket so analytics are visibly-incomplete rather than
  silently wrong while the pile shrinks. (Bulk grouping-by-payee and
  reimbursement auto-suggest are both DONE — see Conventions.)
- **Deeper history.** SimpleFIN caps a request at 90 days (it reports this as a
  feed warning, surfaced on the provider health line). History accumulates
  going forward since syncs never delete; CSV import is the backfill path for
  anything older, and dedups on (accountId, externalId).

## Shipping to other people (agreed 2026-07-25, NOT yet built)

The operator's own instance was tuned interactively — ~160 categorization
rules, transfer patterns, an account-type correction. Someone cloning this from
GitHub has no such help, so the tail of manual review has to be small enough to
walk through alone. What's user-specific ("harborwaymgmt is my landlord") is
exactly what the grouped review exists for; what's structural should ship. Four
items, in value order:

1. **Ship the structural rules.** `DIVIDEND RECEIVED → Income`,
   credit-card-payment detection, ATM-withdrawal handling, and the missing
   `Rent & Housing` / `Taxes` / `Cash & ATM` categories currently exist ONLY in
   the operator's database, not in `rulePack.ts` — a fresh clone gets none of
   them. (`REINVESTMENT → TRANSFER` already ships; ATM appears only as "atm fee"
   under Fees & Charges.)
2. **Strip payment-processor prefixes** in `normalizeMerchant`: `tst*` (Toast),
   `sq *` (Square), `slice*`, `dd *` (DoorDash), `py *`, `spo*`, `gdp*`, `fiv*`
   wrap the real merchant name, degrading both normalization and grouping.
   `tst*`/`slice*`/`dd *` are effectively always food and can auto-categorize;
   `sq *` is NOT (it covers salons and retail too) — don't blanket it.
3. **Expand the shipped brand pack** with the ~100 generic chains identified
   from real data (restaurants, retail, transit).
4. **Fix account-type inference** (`inferAccountType` in simplefin.ts). It keys
   on words like card/visa/credit, so "Chase Sapphire Preferred" fell through to
   DEPOSITORY and silently counted a credit-card balance as an ASSET. Add card
   product names (Sapphire, Freedom, Platinum, Gold, Venture, Quicksilver…).

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

**Session 9 — Cloud deployment (NEXT).** No code is blocking. The remaining work
is the operator's own provisioning, step by step in [DEPLOY.md](DEPLOY.md) —
Claude builds and verifies; the operator creates accounts, logs in, enters
secrets.

## Product direction (agreed 2026-07-13)

Distributed software, NOT a hosted service (the Actual Budget model):
each user deploys their own instance (their machine or their cloud) and
brings their own SimpleFIN token (~$15/yr paid by the user to SimpleFIN),
so the maintainer custodies no one's data and aggregator costs stay $0.
CSV import is the zero-dependency fallback. Do NOT build an in-house
aggregator — bank connectivity (not the protocol) is the hard 95% and
there is no free path. "We can't read your data even if breached" (E2E)
is the product's trust story when multi-user matters.
