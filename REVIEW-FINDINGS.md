# Review findings — three parallel reviews, 2026-07-26

Three read-only agents reviewed docs, code and UI. Docs findings are DONE
(the 2026-07-26 CLAUDE.md trim). What remains is below, prioritised across all three reports.
Delete each item as it lands; delete this file when empty.

Verified before trusting: every claim below was checked against the code or the
running app. Items the reviewers flagged as load-bearing-and-correct were
deliberately NOT included.

---

## P0 — money correctness (wrong on screen right now)

## P1 — mobile (the phone is the reason cloud mode exists)

6. **Charts illegible + data is hover-only.** Fixed viewBox + `w-full` means text
   scales down to 4–7px at 375px. Both Trends charts expose figures only via
   `onMouseMove` — no hover on touch, while the caption says "Hover for exact
   figures". Overview donut renders 76×69px.
   FIX: set SVG text size in px via CSS so it stops scaling; shorter viewBox
   below md; put per-month figures in `aria-label` (the Overview donut already
   does this well — copy that pattern to the other four).

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

11. **`--faint` fails WCAG AA in both light themes** — 3.61:1 sepia (default),
    4.48:1 light; covers 41 text nodes on Overview alone including all column
    headers and the ✎ MANUAL marker at 0.62rem.
    FIX: `~#6f6153` (sepia), `~#5f646b` (light) in `globals.css:142`. Dark passes,
    leave it.

## P3 — categorization workflow

12. **Bulk write commits on `<select>` onChange — no confirm, no undo, no scope
    preview.** Up to 93 transactions plus a persistent priority-50 rule, fired
    from a change event. Keyboard is the sharp edge: on a focused closed select,
    an arrow key fires `change` per option.
    FIX: stage the value, reveal an inline confirm styled like the existing
    `rule` button — "apply to 36 →". The count doubles as scope preview. Add
    "undo last" to the count line.

13. **Pressing "Filter" ejects you from the grouped queue.** The form posts to
    `/transactions` with no `group` field, so `?group=1` is dropped.
    FIX: `{groupMode && <input type="hidden" name="group" value="1" />}`.

14. **1861 of 2,638 transactions unreachable.** `LIMIT=300`, no pagination, and
    nothing hints the Period filter is the way to older data.
    FIX: an "← older" link setting `period` to the month after the last visible
    row — reuses existing filter plumbing, no offset pagination.

15. Decision evidence hidden behind `title=` (no touch support); no skip/defer,
    so unresolvable payees sit at the top forever; entry link styled like body
    text. FIX: stack up to 3 samples inline; per-row `skip`; style the entry as a
    bordered button.

## P4 — performance and cleanup (code review)

Measured: 1,000 txns 0.3s → 10,000 txns 13.7s, and `generateInsights` runs
synchronously inside server actions, so at 10k that's a ~14s hang on a dropdown.

16. **`inPeriod` re-parses its period key on every call** (`periods.ts:111`).
    Independently benchmarked: 610k calls, **419ms → 11ms (38×)**, identical
    results. Module-level `Map<string,{start,end}>`; keys are immutable so it
    can't go stale. ~15 lines, zero money-math exposure. **Do this first, then
    re-measure** — it likely collapses the 10.7s `categoryTotalAnomalies` case on
    its own.

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
