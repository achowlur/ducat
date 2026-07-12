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

1. **Session 1 — Foundation + contracts** (complete): Next.js/TS/Tailwind/shadcn
   project, Prisma schema and initial migration, type contracts in
   `src/types/contracts.ts`.
2. **Session 2 — Insights engine**: reads normalized transactions from the
   database and produces `Insight` records. Runs before the connectors exist,
   so build/test it against seeded fixture data written directly through
   Prisma (matching the `Account`/`Transaction`/`Category` schema) rather than
   live connector output.
3. **Session 3 — Connectors**: SimpleFin and CSV connectors implementing the
   `Connector` interface, normalizing into `NormalizedAccount` /
   `NormalizedTransaction`.
4. **Session 4 — UI**: accounts, transactions, categorization, insights views,
   charts.
5. **Session 5 — Security hardening + audit**: adversarial review of the
   HARD RULES above (credential handling, secrets, localhost binding, no
   outbound calls) across everything built in Sessions 2-4.
