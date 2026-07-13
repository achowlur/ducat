# Finance Project

A local-only personal finance tracker with an insights engine. Runs entirely on
localhost; no financial data ever leaves the machine.

## HARD RULES

- NEVER handle, request, or store bank credentials. Auth happens in the
  aggregator's hosted flow only.
- NEVER hardcode a secret. All secrets via .env (gitignored) or OS keychain.
- NEVER bind the server to anything but 127.0.0.1.
- NEVER add analytics, telemetry, third-party CDNs, or LLM/AI API calls.
  Transaction data must never leave this machine.
- NEVER write placeholder code or TODOs. Everything committed must run.
- TRANSFER-flagged transactions are EXCLUDED from all spending analytics.

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
- Chart discipline (src/components/charts): axis scales must enclose the
  data (`niceTicks` guarantees last tick ≥ max — regression-tested), and
  value labels are collision-checked against every mark, never drawn over
  one.

## Backlog (agreed, not yet scheduled)

- **Bulk P2P categorization for historical CSV imports.** The P2P guard
  (rules.ts) rightly blocks auto-categorizing Zelle/Venmo one at a time,
  but a bulk import of years of history will surface hundreds of P2P
  transactions and manually reviewing each is unacceptable. Ideas to
  evaluate when picked up: (a) group the review queue by payee string so
  one decision ("zelle to john smith → Rent") creates a user rule covering
  all N occurrences at once; (b) auto-suggest reimbursement links by
  amount/date matching against nearby outflows; (c) recurring-pattern
  detection on P2P (same payee, same amount, monthly) to pre-fill rule
  suggestions; (d) an explicit "P2P — Unreviewed" bucket so analytics are
  visibly-incomplete rather than silently wrong while the pile shrinks.
  Grouping-by-payee (a) is the most promising shape: one decision per
  payee, not per transaction.

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
5. **Session 5 — UI** (in progress): App Router shell with tab nav
   (Overview · Trends · Insights · Transactions · Accounts · Providers)
   and a light/dark/sepia theme toggle (sepia default, tokens in
   globals.css, no webfonts). Ledger visual system; charts hand-rolled
   SVG (no chart lib). Done:
   - **Overview** ([src/app/page.tsx](src/app/page.tsx)): uncategorized
     banner (highest-priority), provider-health status line, net worth
     with market-gains decomposition line, accounts table, spending
     donut, tracked subscriptions, signals feed.
   - **Trends** ([src/app/trends/page.tsx](src/app/trends/page.tsx)):
     spending donut with hover + drill-down to filtered Transactions,
     cash-flow bars, net-worth line with market-gains in the tooltip,
     month nav.
   - **Transactions** ([src/app/transactions/page.tsx](src/app/transactions/page.tsx)):
     filter bar, P2P review queue, per-row category picker (MANUAL),
     one-click rule-from-merchant, reimbursement linking; starter rule
     pack (`npm run rules:install`), reimbursements (Category.isIncome,
     Transaction.reimbursesId).
   Pending: **Insights** page (browse/dismiss all insight types),
   **Accounts** page (per-account detail, edit type, stale flags),
   **Providers** page (trust cards + health detail from Session 4).
6. **Session 6 — Security hardening + audit**: adversarial review of the
   HARD RULES above (credential handling, secrets, localhost binding, no
   outbound calls) across everything built in Sessions 2-5. Doubles as the
   deployment gate for Session 7 — its findings become the go-live checklist.
7. **Session 7 — Single-tenant cloud deployment (Plan B, agreed 2026-07-13)**:
   deliberately amends the localhost HARD RULE — the charter becomes
   "local-first by default; OPTIONAL self-hosted cloud deployment with
   auth + encryption; no third party ever custodies the data." Scope:
   Prisma driver swap to libSQL/Turso (better-sqlite3 does not run on
   serverless), single-user auth gate (password/passkey), managed
   encryption at rest, Vercel hobby + Turso free tier, daily sync cron.
   Explicitly deferred: end-to-end encryption (client-side keys +
   analyzers running in the browser — viable because the analyzers are
   pure functions over plain arrays; fetch ciphertext → decrypt in
   browser → compute). E2E is the flagship feature if this becomes a
   shared product.

## Product direction (agreed 2026-07-13)

Distributed software, NOT a hosted service (the Actual Budget model):
each user deploys their own instance (their machine or their cloud) and
brings their own SimpleFIN token (~$15/yr paid by the user to SimpleFIN),
so the maintainer custodies no one's data and aggregator costs stay $0.
CSV import is the zero-dependency fallback. Do NOT build an in-house
aggregator — bank connectivity (not the protocol) is the hard 95% and
there is no free path. "We can't read your data even if breached" (E2E)
is the product's trust story when multi-user matters.
