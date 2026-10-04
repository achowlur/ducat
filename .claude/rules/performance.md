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

- Promise.all buys ~1.13x, not parallelism — buy speed by REMOVING round
  trips; a relation include is one statement each, so select columns.
- Page cost is DOM SIZE (parse + hydration), not bytes on the wire.
- Reimbursement candidates travel ON OPEN (suggestCandidates), never
  serialized per ledger row; the collapsed hint and the opened list share
  ONE projection path (makeCandidateFinder) — its wide-pool/narrow-pool
  equivalence is pinned by test and holds under REIMBURSE_POOL_TAKE.
- Analyzer cost is BUCKETING: period bounds memoized, per-period buckets
  computed once — generateInsights runs synchronously inside server actions.
