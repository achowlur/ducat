# Ducat

A personal finance tracker with an insights engine. Local-first by default (runs
entirely on localhost; no financial data leaves the machine), with an OPTIONAL
single-tenant self-hosted cloud deployment (Session 7 — see DEPLOY.md).

## HARD RULES

Absolute (BOTH modes):
- NEVER handle, request, or store bank credentials. Auth happens in the
  aggregator's hosted flow only.
- NEVER hardcode a secret. All secrets via .env (gitignored), the OS keychain,
  or the deployment platform's env-var store.
- NEVER add analytics, telemetry, third-party CDNs, or LLM/AI API calls.
- NEVER write placeholder code or TODOs. Everything committed must run.
- TRANSFER-flagged transactions are EXCLUDED from all spending analytics.

Mode-scoped (amended Session 7 — `DATABASE_URL` scheme selects the mode):
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

## Stack

- Next.js 15 (App Router) + TypeScript strict mode
- Tailwind CSS + shadcn/ui
- Prisma + SQLite (`./data/finance.db`)

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
- Useful commands: `npm run db:seed` (deterministic fixture data),
  `npm run insights:generate [-- --granularity=WEEK|MONTH|QUARTER|YEAR]`,
  `npm test`.
- NEVER run `npm run build` while the dev server is running — both share
  `.next/`, and the build corrupts the dev server's chunks (symptom:
  "Cannot find module './NNN.js'" and silent hydration failure — no client
  handler works). Fix: stop dev, delete `.next/`, restart.
- After a Prisma migration, RESTART the dev server: the PrismaClient
  global singleton (src/lib/prisma.ts) survives hot-reload with the old
  generated client (symptom: PrismaClientValidationError, "Unknown field"
  for a column that exists).
- `npm run db:seed` wipes insights; re-run `npm run insights:generate`
  afterwards or pages show "no data".
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
  exactly that month:
  `npm run import:balances -- --template [--months=N] > balances.csv` (rows for
  every uncovered month, newest first; blanks are skipped), fill from each
  statement's "Ending Account Value", then `-- balances.csv [--dry-run]`.
  History otherwise grows one snapshot per sync. `marketGains` only computes
  once two consecutive periods are snapshot-backed.
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
  happened. `periodCoverage`/`coverageFloor` quantify this and `CoverageNotice`
  surfaces it on Trends/Insights — visibly incomplete beats silently wrong.
  An account counts as covering a period only if its first transaction is at
  or before the period START (mid-period starts are partial).
- Chart discipline (src/components/charts): axis scales must enclose the
  data (`niceTicks` guarantees last tick ≥ max — regression-tested), and
  value labels are collision-checked against every mark, never drawn over
  one.

## Backlog (agreed, not yet scheduled)

- **Bulk categorization — grouping-by-payee, idea (a): DONE** (2026-07-25).
  `src/lib/sync/grouping.ts` groups the uncategorized backlog by payee and
  `/transactions?group=1` renders it (`GroupedReview`), one decision per payee
  writing a user rule that also covers future transactions
  (`categorizeGroup` in transactions/actions.ts). P2P groups key on a payee
  string derived from the description (`payeeKey` strips ref numbers/dates), so
  "zelle to lena" and "zelle to hollis amari" stay distinct instead of collapsing
  into the meaningless "zelle transfer" rail — those rules match DESCRIPTION,
  which the P2P guard permits for user-priority rules. Real-world leverage:
  355 uncategorized transactions were only 150 payees; one decision cleared 36.
- **Reimbursement auto-suggest, idea (b): DONE** (2026-07-25).
  `src/lib/insights/suggestReimbursements.ts` ranks the outflows an inflow might
  repay. AMOUNT evidence leads (exact, clean 1/n, or a rounded ≈1/n — people
  send $62.2 for a $61.55 share) and date proximity only breaks ties; ranking by
  date alone put last night's rent above the dinner a $116.63 Zelle actually pays
  back. Outflows in unsplittable categories (rent, taxes, fees, utilities,
  subscriptions, health, ATM — `UNSPLITTABLE` in transactions/page.tsx) are
  denied split evidence, since arithmetic alone can't tell "1/5 of a dinner"
  from "1/6 of a tax bill". `strong` tracks amount evidence ALONE: an exact
  repayment three weeks later is still conclusive.
- Still open from that item: (c) recurring-pattern
  detection on P2P (same payee, same amount, monthly) to pre-fill rule
  suggestions; (d) an explicit "P2P — Unreviewed" bucket so analytics are
  visibly-incomplete rather than silently wrong while the pile shrinks.
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
   `REINVESTMENT → TRANSFER`, credit-card-payment detection, ATM handling, and
   the missing `Rent & Housing` / `Taxes` / `Cash & ATM` categories currently
   exist ONLY in the operator's database, not in `rulePack.ts` — a fresh clone
   gets none of them.
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

1. **Session 1 — Foundation + contracts** (complete): Next.js/TS/Tailwind/shadcn
   project, Prisma schema and initial migration, type contracts in
   `src/types/contracts.ts`.
2. **Session 2 — Insights engine** (complete): five analyzers in
   `src/lib/insights/` (net worth growth, spending by category, cash-flow
   trend, recurring charges, anomalies) producing typed `Insight` records at
   configurable period granularity; `BalanceSnapshot` model added; seeded
   fixture data via `npm run db:seed`; Vitest suite.
3. **Session 3 — Connectors** (complete): SimpleFIN connector (access URL
   from .env, setup-token claim flow, pending transactions skipped, account
   type inferred from name keywords) and CSV connector (mapping configs for
   chase-checking / chase-credit / wells-fargo / fidelity; deterministic
   hashed externalIds; Fidelity trades pre-flagged TRANSFER). Full sync
   pipeline in `src/lib/sync/`: upsert accounts → balance snapshots →
   dedup import → category rules (priority asc, first match wins, MANUAL
   never overridden) → cross-account transfer-pair detection (exact
   opposite amounts, ≤4-day window) → insight regeneration. Commands:
   `npm run sync:simplefin`, `npm run import:csv`, `npm run simplefin:claim`.
4. **Session 4 — Provider health + subscription tracking** (complete):
   `SyncLog` persists every sync outcome (success and failure, feed
   warnings via the optional `Connector.feedWarnings()` contract method);
   `src/lib/health/` derives per-provider status (OK/WARN/ERROR/UNKNOWN)
   from LOCAL signals only — last sync outcome, feed errors, stale balance
   dates, transaction-volume gap detection — no network on launch, ever.
   Provider trust cards in `providers.ts` (add one when adding a
   connector). `TrackedSubscription` reconciles registered subscriptions
   against imported charges: next-payment projection from last real charge
   (falling back to anchor) and cent-exact price-drift flagging on the
   first deviating charge. `npm run health` prints the panel headless.
5. **Session 5 — UI** (complete): App Router shell with tab nav and a
   light/dark/sepia theme toggle (sepia default, tokens in globals.css,
   no webfonts). Ledger visual system; charts hand-rolled SVG (no chart
   lib). Six tabs:
   - **Overview** ([src/app/page.tsx](src/app/page.tsx)): uncategorized
     banner (highest-priority), provider-health status line, net worth
     with market-gains decomposition line, accounts table, spending
     donut, tracked subscriptions, signals feed.
   - **Trends** ([src/app/trends/page.tsx](src/app/trends/page.tsx)):
     spending donut with hover + drill-down to filtered Transactions,
     cash-flow bars, net-worth line with market-gains in the tooltip,
     month nav.
   - **Insights** ([src/app/insights/page.tsx](src/app/insights/page.tsx)):
     all five types rendered in plain language ("N× typical"), month nav,
     dismiss/restore (survives regeneration via insight identity;
     propagates to Overview signals; never silences TrackedSubscription
     warnings).
   - **Transactions** ([src/app/transactions/page.tsx](src/app/transactions/page.tsx)):
     filter bar, P2P review queue, per-row category picker (MANUAL),
     one-click rule-from-merchant, reimbursement linking; starter rule
     pack (`npm run rules:install`), reimbursements (Category.isIncome,
     Transaction.reimbursesId).
   - **Accounts** ([src/app/accounts/page.tsx](src/app/accounts/page.tsx)):
     grouped by type, snapshot sparklines, stale chips, type correction
     (regenerates insights, survives syncs), per-account drill-down.
   - **Providers** ([src/app/providers/page.tsx](src/app/providers/page.tsx)):
     trust cards (data path, residual risks, revocation), health signals,
     last-20 sync history, setup hints for unconfigured providers; the
     access URL credential is never displayed, only its presence.
6. **Session 6 — Security hardening + audit** (complete): adversarial review
   of the HARD RULES across Sessions 2-5 found all six hold in code (no active
   violation). The gap was that "nothing leaves the machine" rested on
   developer discipline alone; hardening converted it into enforced controls:
   - Strict CSP + security headers in `next.config.ts` (`headers()`):
     `connect-src`/`default-src 'self'` block any off-origin
     fetch/XHR/WebSocket/beacon at the browser boundary; dev adds
     `'unsafe-eval'` + same-origin HMR ws (required for Fast Refresh — don't
     remove). Also `frame-ancestors 'none'`, `poweredByHeader:false`.
   - `src/middleware.ts`: host-allowlist (127.0.0.1/localhost only) as
     anti-DNS-rebinding defense; 403s any non-loopback `Host`. Matcher skips
     `_next/static|_next/image|favicon.ico`.
   - `NEXT_TELEMETRY_DISABLED=1` in `.env`/`.env.example` (per-repo, since
     `next telemetry disable` is only a per-machine global).
   - `SimplefinConnector` redacts the access URL from URL-parse errors.
   - README rewritten to document the local-only trust model.
   Go-live checklist for Session 7: auth + encryption become hard blockers,
   and the CSP/headers matter even more on a public origin (add HSTS there).
7. **Session 7 — Single-tenant cloud deployment** (code complete 2026-07-13;
   the deploy itself is the operator's step — see [DEPLOY.md](DEPLOY.md)):
   amended the localhost HARD RULE (see Mode-scoped rules above). Built and
   verified locally:
   - DB driver swapped better-sqlite3 → `@prisma/adapter-libsql` (one adapter:
     `file:` local + `libsql://` Turso, by DATABASE_URL). `postinstall: prisma
     generate` (the gitignored client must build on Vercel); better-sqlite3
     kept as a devDep for the test harness. `serverExternalPackages` → libSQL.
   - Single-user password auth: scrypt hash (Node crypto, no native dep) + a
     jose HS256 signed-cookie session verified in Edge middleware; fail-closed
     in cloud mode; `requireSession()` on every Server Action; login page +
     `npm run auth:set-password`. GOTCHA: the stored hash uses a `:` delimiter,
     NOT `$` — Next's `.env` loader expands `$name` and silently mangles a
     `$`-delimited hash to "scrypt".
   - `src/middleware.ts` host-allowlist is now cloud-aware (loopback enforced in
     local mode only, else it 403s the deploy host).
   - Daily sync cron: `src/app/api/cron/sync/route.ts` (nodejs, CRON_SECRET
     Bearer) + `vercel.json` crons; reuses `runSync`. HSTS in production.
     `npm run turso:baseline` emits the schema SQL for `turso db shell`.
   - Encryption at rest = Turso's (managed; BYOK optional). Explicitly deferred:
     end-to-end encryption (client-side keys + analyzers in the browser — viable
     because the analyzers are pure functions over plain arrays). E2E is the
     flagship feature if this becomes a shared product.

8. **Session 8 — Real data onboarding + analytics correctness** (complete
   2026-07-25). The operator's live SimpleFIN feed replaced fixture data, then
   25 months of history was backfilled by CSV. Everything below was found BY
   running on real money — none of it showed up against seeded data:
   - CSV mappings were wrong against real exports: Wells Fargo actually ships a
     HEADERED file (the mapping described a headerless one with a different
     column order, so it would have read descriptions as amounts); WF includes
     PENDING rows that must be skipped; Fidelity's `/\btransfer\b/` never
     matched "TRANSFERRED" and had no pattern for its ACH descriptor, which put
     ~$209.15k of internal transfers into SPENDING.
   - Backfill needed `--external-id` merging (account lookup falls back across
     connector types) and `--until` (CSV ids are content hashes, feed ids are
     the feed's own — overlapping rows do NOT dedupe).
   - Bulk categorization by payee, reimbursement auto-suggest, coverage
     flagging, `db:reset`, and `import:balances` all landed here.
   - Net worth and anomaly analytics were both fabricating results at scale —
     see the two Conventions entries above. These are the highest-value lessons
     in this file.
   Result: 197 → 2,638 transactions across 21 accounts, non-P2P categorization
   backlog cleared, 181 tests.
9. **Session 9 — Cloud deployment (NEXT).** Nothing in the app is blocking; all
   Session 7 code is verified locally. The remaining work is the operator's own
   provisioning, in [DEPLOY.md](DEPLOY.md): create the Turso DB, apply the
   schema via `npm run turso:baseline | turso db shell`, generate secrets
   (`npm run auth:set-password`, CRON_SECRET), set Vercel env vars, deploy,
   then verify auth + cron + headers. Claude cannot create accounts, log in, or
   enter secrets — it builds and verifies, the operator provisions.

## Product direction (agreed 2026-07-13)

Distributed software, NOT a hosted service (the Actual Budget model):
each user deploys their own instance (their machine or their cloud) and
brings their own SimpleFIN token (~$15/yr paid by the user to SimpleFIN),
so the maintainer custodies no one's data and aggregator costs stay $0.
CSV import is the zero-dependency fallback. Do NOT build an in-house
aggregator — bank connectivity (not the protocol) is the hard 95% and
there is no free path. "We can't read your data even if breached" (E2E)
is the product's trust story when multi-user matters.
