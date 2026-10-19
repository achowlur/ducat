---
paths:
  - "src/app/**"
  - "src/components/**"
  - "src/lib/**"
---

# Rules: performance

Evidence: docs/conventions/performance.md. Read it before changing anything
below. On Turso the COUNT of round trips is the cost (CLAUDE.md). Measuring
anything, or claiming a speed-up: the `perf-measure` skill.

- Turso BILLS ROWS READ and blocks every database in the account at the
  plan's monthly limit. Every foreign key's CHILD column carries an index
  (scripts/foreignKeyIndexes.test.ts): without one, deleting a parent scans
  the whole child table per row, and the demo reset read ~100M rows a time.
- Every libSQL client that reaches Turso fetches through `meteredFetch`
  (lib/usage/meter.ts), or its rows are missing from /providers' free-plan
  counts; the meter writes AFTER the response, never on its path.
- The demo reset HOLDS once the month's rows read or written pass 25% of the
  free plan (DEMO_RESET_CAP_SHARE), and lib/demo/resetPlans.test.ts fails on
  any statement the nightly job plans with a full SCAN that runs per row.
- Promise.all buys ~1.13x, not parallelism — buy speed by REMOVING round
  trips; a relation include is one statement each, so select columns.
- Page cost is DOM SIZE (parse + hydration), not bytes on the wire.
- Reimbursement candidates travel ON OPEN (suggestCandidates), never
  serialized per ledger row; the collapsed hint and the opened list share
  ONE projection path (makeCandidateFinder) — its wide-pool/narrow-pool
  equivalence is pinned by test and holds under REIMBURSE_POOL_TAKE.
- Analyzer cost is BUCKETING: period bounds memoized, per-period buckets
  computed once — generateInsights runs synchronously inside server actions.
- Every page loader's statements are planned on demo data
  (ui/pagePlans.test.ts): no full scan per row, and no whole-table read of
  Transaction under a page or a test of an indexed column. A new filter on
  Transaction owes an index (schema, additive: schema:push on BOTH cloud
  databases BEFORE the merge). Indexed today: date, groupLabel, categoryId and
  both self-links; Insight(type, period); SyncLog(connectorType, finishedAt).
- An EDIT regenerates insights from its earliest touched date (regenerateForRows,
  insights/scope.ts: SCOPE_LOOKBACK_MONTHS back, through the latest), never the
  whole history; sync, upgrade and scripts run in full, and a full MONTH run
  clears WEEK/QUARTER/YEAR strays. scopedRegeneration.test.ts holds a scoped
  run to a full one byte for byte.
- A page reads only the insight types and months it draws (Overview, in ONE
  statement: spending 12 months, net worth and cash flow 24 for the goals, this
  month's recurring charges; /insights: not ANOMALY except its month); health
  counts rows per account with aggregates, never one row per transaction.
