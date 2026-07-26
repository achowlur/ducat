# Review findings — three parallel reviews, 2026-07-26

Three read-only agents reviewed docs, code and UI. Docs findings are DONE
(the 2026-07-26 CLAUDE.md trim). What remains is below, prioritised across all three reports.
Delete each item as it lands; delete this file when empty.

Verified before trusting: every claim below was checked against the code or the
running app. Items the reviewers flagged as load-bearing-and-correct were
deliberately NOT included.

---

## P4 — performance and cleanup (code review)

`generateInsights` runs synchronously inside server actions, so analyzer time
is a hang on a dropdown.

**Re-measured after #16 landed** (10,000 synthetic txns, 26 periods, analyzers
only, no DB):

| | before | after |
|---|---|---|
| computeSpendingByCategory | 310 ms | 14 ms |
| computeCashFlowTrend | 303 ms | 14 ms |
| detectCategoryTotalAnomalies | 1,895 ms | 66 ms |
| detectTransactionAnomalies | 1,628 ms | **1,455 ms** |
| total | 4,143 ms | 1,553 ms |
| `inPeriod` × 610k | 393 ms | 10 ms |

So the next perf item is no longer any of the ones below: `detectTransactionAnomalies`
is now 94% of the remaining time, and memoization barely touched it because its
cost is the O(n²) history re-filter per transaction (`anomalies.ts:42`), not
period parsing. Group the history by category/merchant once per period instead.

18. `monthlyInsights` exists 3× and has diverged (overview newest-first +
    `dismissed`; trends oldest-first without). Unify carefully — reversing a sort
    silently flips Trends' charts.

19. Overview issues ~20 sequential queries, 4 full Insight table scans,
    RECURRING_CHARGE fetched twice. `ui/insights.ts:110` already demonstrates the
    partition-in-memory pattern.

20. `installRulePack` does ~180 sequential existence queries; per-row `update()`
    loops where `updateMany` fits; two full-table loads in `health/`.

**Deferred deliberately:** DB indexes (free at 2,638 rows, and a migration right
before deploy invites the dev-server-restart gotcha); the analyzer restructures
in the reviewer's Tier C (re-measure after #16 first).

---

## Explicitly NOT to be "fixed" — verified still load-bearing

The code reviewer independently re-verified these against current code and
recommended leaving every one alone: the four merchant-string reducers
(`normalizeMerchant`, `payeeKey` truncate-not-delete, `collapse` in `rules.ts`,
`brandOf`); the account-lookup fallback vs `matchAccount`; MANUAL exclusions in
`sync.ts` and `rules.ts`; the `known:false` / `investmentSnapshotNotBefore`
contract; the "only active periods" anomaly baseline; and the
`internalActivity`/`inboundWording`/`outboundWording` triple.

The UI reviewer likewise flagged as working and not to be touched: `/providers`
(best screen, only page with zero overflow at 375px); coverage notices existing
at all; refusing to draw net worth it can't know; the reimbursements-exceeded
empty state; the grouped-review P2P tooltip; money typography; and the Overview
net-worth market-movement line.
