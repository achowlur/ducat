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
- `npm run db:seed` wipes insights; re-run `npm run insights:generate`
  afterwards or pages show "no data".
- Chart discipline (src/components/charts): axis scales must enclose the
  data (`niceTicks` guarantees last tick ≥ max — regression-tested), and
  value labels are collision-checked against every mark, never drawn over
  one.

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
5. **Session 5 — UI**: accounts, transactions, categorization, insights views,
   charts; launch screen shows the provider-health panel and subscription
   status from Session 4.
6. **Session 6 — Security hardening + audit**: adversarial review of the
   HARD RULES above (credential handling, secrets, localhost binding, no
   outbound calls) across everything built in Sessions 2-5.
