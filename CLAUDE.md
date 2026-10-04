# Ducat

A personal finance tracker with an insights engine. Local-first by default (runs
entirely on localhost; no financial data leaves the machine), with an OPTIONAL
single-tenant self-hosted cloud deployment (see [DEPLOY.md](DEPLOY.md)).

## Where instructions live

This file loads into every session, so it holds only what applies to almost any
change. The rest loads when it is needed:

| Tier | Holds | Loads |
|---|---|---|
| CLAUDE.md | hard rules, architecture, rules any change can break | every session |
| `.claude/rules/*.md` | one-line rules for one area of the code | when a file matching its `paths:` is read or edited |
| `.claude/skills/*/SKILL.md` | procedures: commit, ship a PR, change cloud data | when the task matches, or by `/name` |
| `docs/conventions/*.md` | the EVIDENCE: what each rule cost, what failed | REQUIRED READING before changing what a rule covers |

A new convention gets ONE rule line in ONE tier (any change → here; one area's
files → its rules file; a task → its skill) and its story in docs/conventions,
never both in one place. Several evidence files record "tried and failed, don't
retry". This file stays under 200 lines and every rules file keeps live `paths:`
(scripts/instructions.test.ts). Backlog, open items only: docs/backlog.md.
History: docs/history.md. User guides: docs/getting-started.md and siblings.

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
  custodies it as a shared service. Opt-in trade-off documented in DEPLOY.md
  AND carried on /providers (ui-reports.md); E2E is deferred.

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

## Every change

- Sign convention (SimpleFIN-style, documented in `src/types/contracts.ts`):
  transaction amounts are signed (positive = INFLOW, negative = OUTFLOW,
  TRANSFER either); balances are signed (CREDIT/LOAN negative), so net worth
  is the plain sum of balances. Insight payloads report positive magnitudes,
  except net worth which stays signed.
- Period keys: `2026-W28` (ISO week) / `2026-07` / `2026-Q3` / `2026`.
- `BalanceSnapshot` rows are the source of truth for historical balances;
  the engine falls back to reconstructing from transactions (flagged as
  estimated) for accounts/periods without snapshots. Connectors should write
  a snapshot on every sync.
- MANUAL categorization is sacred: any path that rewrites flow or category
  must EXCLUDE manually-categorized rows, as transfer-pair detection does.
- Analyzers legitimately emit NOTHING; every consumer survives an empty
  series — guard the series itself, never assume a page gate covers it.
- Commands: README's table and `package.json`; `npm test` is Vitest.
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
  transactions exist unless given `-- --yes` (same guard as `db:reset`). It
  loads INVENTED demo data dated relative to TODAY (src/lib/demo/data.ts) and
  rebuilds insights itself.
- TWO DATABASES: code ships with git push, DATA does not. Every data change
  runs against the CLOUD only, the only writer; the nightly mirror brings
  local down, and a local write makes it refuse. Every row-writing script
  prints its database label FIRST — read it. Load `cloud-data-change` first.
- Every change lands on a BRANCH and through a PULL REQUEST — never a commit
  on main, Claude Code's sessions included — and a PR merges only on a green
  `verify` check. The steps, privacy scan included, are the `ship-pr` skill.
- NOTHING PUBLIC carries personal data: tracked files (`.claude/rules/` and
  `.claude/skills/` included), commits, branch names, PR text, comments, the
  About fields. A new figure is INVENTED, never read from real data
  (publishing.md in `.claude/rules/`).
- `npm test` excludes `.claude/**` (vitest.config.ts): agent worktrees there
  are full repo copies, and without it the suite silently doubles and gates
  on another branch's work.
- Browsing is limited to the IN-APP browser (`preview_start` /
  `mcp__Claude_Browser__*`), pointed at `<your-deployment>.vercel.app` or localhost.
  Never drive the operator's real Chrome or read their existing tabs and
  sessions, for this or anything else. When something genuinely needs an
  authenticated session the in-app browser does not have — the Vercel
  dashboard, Turso's console — ASK, and never enter credentials anywhere.
- On Turso the COUNT of round trips is the cost, never the size of any one.

## Every rendered surface (evidence: docs/conventions/ui-and-pages.md)

- PHONE IS THE PRIMARY READ. Every control clears 44px below md via the
  `.tap44` utility (min-height, never the header's negative-margin pair —
  that overlaps neighbours inside a row); any strip with a hidden scrollbar
  opens at the END the reader needs, not at scrollLeft 0; and the one figure
  a screen exists for never lives in a column that can be scrolled off — the
  ledger's amount moves into the merchant sub-line below md.
- DATES pin to UTC; INSTANTS render local wall-clock plus zone name via
  dateTime(); the zone comes from DUCAT_TIMEZONE (EMPTY falls back to the
  machine's), never TZ. Never print a raw
  ISO string in prose — shortDate/monthLabel exist.
- On-screen copy carries NO em dash (a refusal glyph and an empty cell's
  dash are glyphs, not prose).
- Headings come from components/ui/headings.tsx and NOWHERE else: one h1 per
  tab (visually hidden — the nav carries the visible name), SectionTitle is
  h2, SubsectionTitle h3, and every column header's type is COLUMN_HEADER.
  Every `th` carries scope.
- A warning wears the warning tokens (`--warn` fill, `--on-warn` on it,
  `--warn-ink` as text), never a chart colour; charts never wear them.
- A figure the reader must be able to discount states its uncertainty in TEXT,
  never in a title= — hover does not exist on the device this is read on.
  Percentages of one whole round by largest remainder (wholePercents), or a
  column of them sums to 101%.
- Charts are hand-rolled SVG; no chart library, no webfonts anywhere (CSP).
- An SVG `<title>` takes ONE string child: two JSX children serialize as
  `<title></title>` server-side, and the mismatch re-renders from `<html>`
  down, stripping the pre-paint data-theme. Any hydration error: load
  `debug-hydration` before guessing.
- Every test or probe for a failure state asserts on content that is PRESENT,
  since an absent-string check passes on a page that never rendered.

## Routing

| Working on | Rules file in `.claude/rules/` | Evidence in `docs/conventions/` |
|---|---|---|
| analyzers, totals, net worth, reimbursements, trips, the closed box | money-and-analytics.md | money-and-analytics.md |
| merchant normalizer, rule pack, matcher, categories, P2P | merchants-and-rules.md | merchants-and-rules.md |
| sync, CSV import, backups, mirror, schema, cron, FRED, health | sync-and-data-ops.md | sync-and-data-ops.md |
| goals, readiness, subscriptions, the digest | goals-and-insights.md | goals-and-insights.md |
| /transactions, its filters and popovers | ui-ledger.md | ui-and-pages.md |
| Overview, /trends, /insights, /accounts, /providers, charts | ui-reports.md | ui-and-pages.md |
| page and query cost | performance.md | performance.md |
| auth, middleware, CSP, demo mode, install scripts | security-and-auth.md | security-and-auth.md |
| tests, fixtures, docs, README, demo data | publishing.md | publishing.md |

Skills in `.claude/skills/`, each listed with its trigger in every session:
`verify`, `ship-pr`, `cloud-data-change`, `backup-mirror` (backups, mirror,
fingerprints), `perf-measure` (any timing claim), `worktree-agents`,
`debug-hydration`. A skill opens by reading the rules file it depends on.

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

## Product direction

Distributed software, NOT a hosted service: each user deploys their own
instance and brings their own SimpleFIN token; CSV import is the fallback. Do
NOT build an in-house aggregator. The agreement, with its reasons, is in
docs/history.md.
