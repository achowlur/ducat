---
paths:
  - "src/lib/insights/**"
  - "src/lib/sync/**"
  - "src/lib/connectors/**"
  - "src/lib/health/**"
  - "src/lib/ui/**"
  - "src/app/**"
  - "src/components/**"
  - "src/lib/demo/**"
  - "scripts/{upgrade,import-csv,import-balances,generate-insights,seed}.ts"
---

# Rules: money & analytics

Evidence: docs/conventions/money-and-analytics.md. Read it before changing
anything below; several entries record "tried and failed, don't retry".
(MANUAL is sacred and analyzers may emit nothing: both in CLAUDE.md.)

- Insight regeneration replaces existing rows per (type, period) but carries
  the `dismissed` flag forward for insights with the same identity
  (see `identityOf` in `src/lib/insights/engine.ts`).
- Reimbursements push categories NEGATIVE by design: arcs divide by drawable,
  every PRINTED total is net totalSpending (single source:
  ui/spendingBreakdown.ts), and pctDelta is null when EITHER operand crosses
  zero (base ≤ 0 OR current < 0); /trends prints no percentage then, only
  dollars.
- /trends computes from TRANSACTIONS through ui/report.ts ENTRIES, never a
  second definition of spending or income: a credit files under the row it
  nets against (reimbursementSources), and every month's totals are pinned to
  the analyzers to the cent (report.test.ts).
- Net worth history requires SNAPSHOTS: investment accounts are known:false
  without a snapshot INSIDE the period; never reconstruct an investment
  balance from transactions, in either direction. Cash/credit are exempt.
- investmentNetFlows counts only money CROSSING the account boundary;
  direction comes from wording, only the magnitude is trusted.
- Never trust one connector's sign convention — investment-amount readers
  must be robust to Fidelity-CSV and SimpleFIN signing the same transfer
  oppositely.
- Fidelity's sweep into the core position ("PURCHASE INTO CORE ACCOUNT") is
  INTERNAL: a pack TRANSFER rule and a netWorth internal verb. Its sign
  differs between accounts, so it is caught by WORDS; reapplying rules never
  undoes a transfer pair it already won.
- Anomaly baselines use ACTIVE periods only; anomalies RANK
  (maxPerBaseline: 1) with minPercentile 0.85 as an eligibility gate;
  displayed magnitude is a rank ("higher than N%"), never a ratio.
  Log-space MAD and merchant-history baselines failed — do not retry.
- A coverage gap is TWO claims: a mid-period start is complete data,
  only NO_DATA earns amber, and notices report DOLLARS, not account counts.
- An account covers a period only if its first transaction is at or before
  the period START.
- Reimbursement suggestions lead with AMOUNT evidence; date only breaks
  ties; UNSPLITTABLE categories are denied split evidence. An expense up to
  REPAYMENT_LEAD_DAYS (30) AFTER the repayment is offered — unpenalised within
  POSTING_LAG_DAYS (3), at 60% date weight beyond — ONE constant feeds both
  the ranker and the pool queries. Suggestions are a GUESS: the picker's
  SEARCH reaches every expense in the window, so ranking never decides
  whether a link is possible.
- A trip/project group (`Transaction.groupLabel`) is a cross-period VIEW
  over real rows, never a re-bucketing: NO analyzer reads it, tagging
  changes no printed total (pinned byte-identical by groupLabel.test.ts),
  and every row-rewriting path — dedup import, reapplyRules, its undo,
  transfer-pair detection — leaves the tag standing, the MANUAL
  protection arriving from the opposite direction.
- An INVESTMENT account is a CLOSED BOX (sync/closedBox.ts): every
  non-MANUAL row in one is a TRANSFER by the ACCOUNT'S TYPE, before any rule
  is asked, user rules included. Dividends, sales and fees inside one are
  never income or spending; what it earned is the market-movement figure.
  Pairing is still OFFERED an enclosed row that could cross the boundary;
  enclosed rows are counted apart and never in a rule's undo snapshot;
  retyping OUT of INVESTMENT releases them (releaseClosedBox).
