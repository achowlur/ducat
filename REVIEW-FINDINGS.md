# Review findings — three parallel reviews, 2026-07-26

Three read-only agents reviewed docs, code and UI. Docs findings are DONE
(the 2026-07-26 CLAUDE.md trim). What remains is below, prioritised across all three reports.
Delete each item as it lands; delete this file when empty.

Verified before trusting: every claim below was checked against the code or the
running app. Items the reviewers flagged as load-bearing-and-correct were
deliberately NOT included.

---

## P0 — money correctness (wrong on screen right now)

## P2 — trust and data integrity

8. **U+FFFD in account names.** "WELLS FARGO TRAVEL REWARDS VISA?? CARD ...0005" —
   the ® was mis-decoded at import. Appears on Overview, the Transactions account
   filter, Accounts, and mid-sentence inside both coverage notices.
   FIX: strip `�` in connector account-name normalization; check the
   SimpleFIN response encoding at source, not just at display.

9. **One Verizon subscription appears 3× on `/insights`, two of them dead.**
   Overview applies the two-cadence-cycle recency filter and annualises correctly
   ($5,039.25/yr); `/insights` doesn't apply it.
   FIX: apply the same filter to the RECURRING insight list, or group lapsed
   under "no longer charging". (`paymentrec urring` is a good candidate for the
   `normalizeMerchant` prefix-stripping already on the backlog.)

10. **"3 standing risks" is a static array length dressed as live status.**
    `residualRisks.length` from a hardcoded array — always 3, reads as "3 things
    are wrong now". Compounded: the 90-day SimpleFIN cap is permanent, so the
    provider sits at WARN forever and the indicator gets ignored. Also
    `page.tsx:59` `.toLowerCase()` mangles a full sentence that `/providers`
    renders correctly.
    FIX: drop "standing risks" from Overview (it's excellent on `/providers`);
    treat the 90-day cap as expected, not WARN; keep the reason's casing.

## P3 — categorization workflow

14. **1861 of 2,638 transactions unreachable.** `LIMIT=300`, no pagination, and
    nothing hints the Period filter is the way to older data.
    FIX: an "← older" link setting `period` to the month after the last visible
    row — reuses existing filter plumbing, no offset pagination.

15. Decision evidence hidden behind `title=` (no touch support); no skip/defer,
    so unresolvable payees sit at the top forever; entry link styled like body
    text. FIX: stack up to 3 samples inline; per-row `skip`; style the entry as a
    bordered button.

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

17. Safe mechanical dedup: `monthLabel` duplicated (`ui/overview.ts:70` vs
    exported `ui/trends.ts:47`); `Rule→RuleData`/`Txn→RuleTxn` mapping blocks
    identical in `sync.ts:207` and `rulePack.ts:192`; `function arg()` in three
    scripts; `ACCOUNT_TYPES` duplicated; `coverageFloor` is a dead export.

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
