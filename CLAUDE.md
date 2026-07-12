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

## Build order and status

1. **Session 1 — Scaffold** (complete): Next.js/TS/Tailwind/shadcn project,
   Prisma schema and initial migration, type contracts in
   `src/types/contracts.ts`.
2. **Session 2 — Connectors**: SimpleFin and CSV connectors implementing the
   `Connector` interface.
3. **Session 3 — Insights engine**: reads normalized transactions, produces
   `Insight` records.
4. **Session 4 — UI**: accounts, transactions, categorization, insights views.
