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
- **Overview donut should link to `/trends`.** `MiniDonut` is not wrapped in
  anything clickable. Slices already carry `categoryId`, so slice → filtered
  transactions is the natural pair with the item below.
- **Trends donut "Other" should open those transactions.** `TOP_SLICES = 3`, so
  "Other" is everything ranked 4th and below (8 categories, $2005.74 in July
  2026). Needs a multi-category filter — `?category=id1,id2,id3` →
  `categoryId: { in: [...] }` — because today it takes one id or
  `"uncategorized"`. The catch: which categories land in "Other" CHANGES BY
  PERIOD, so the link must enumerate the ids for the month on screen rather
  than pass a static `other` token. Prefer an inclusion list to an exclusion
  one, or a category added later joins "Other" silently.
- **Another pass on subscription detection.** The detector needs 3+
  occurrences, amounts within 25%, and gaps inside a cadence band (monthly =
  26–35 days); `TrackedSubscription` has 0 rows, so everything shown is
  detected and nothing is registered by hand. Likely blind spots: annual plans
  (3 occurrences = 3 years), anything varying more than 25%, and merchants
  whose string shifts between charges. Do the read-only "what did it miss"
  report — merchants with 3+ charges at regular gaps that are NOT reported —
  before touching any threshold. (Zego is not a mystery: it is a rent-payment
  portal, formerly PayLease, and the $7.88/month is its convenience FEE, not
  rent — which is exactly why rent-portal rules deliberately did not ship.)
- **A public demo instance** with fabricated data. Blocked on a decision, not
  on code: the mode-scoped HARD RULE says cloud mode MUST have the auth gate
  and fails closed, so a login-less demo is an explicit amendment to that rule
  and has to be documented as one. It also has to be genuinely read-only
  (mutations blocked, not hidden, and no `SIMPLEFIN_ACCESS_URL`), on its own
  Vercel project and Turso database. Most of the work is the DATA, not the
  deployment: `db:seed` exists but demo fixtures need month-end snapshots per
  investment account or net worth refuses to draw, plus enough history for
  anomalies and subscriptions to fire, or the tour is a gallery of empty states.

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

STILL OPEN: the cloud database holds schema + 15 categories + 421 pack rules
and ZERO transactions, while local holds 1018 plus ~160 hand-tuned rules at
priority ≤50. Nothing has synced into the cloud yet, because a clean copy of
local history only goes into an empty database.

## Product direction (agreed 2026-07-13)

Distributed software, NOT a hosted service (the Actual Budget model):
each user deploys their own instance (their machine or their cloud) and
brings their own SimpleFIN token (~$15/yr paid by the user to SimpleFIN),
so the maintainer custodies no one's data and aggregator costs stay $0.
CSV import is the zero-dependency fallback. Do NOT build an in-house
aggregator — bank connectivity (not the protocol) is the hard 95% and
there is no free path. "We can't read your data even if breached" (E2E)
is the product's trust story when multi-user matters.
