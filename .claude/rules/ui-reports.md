---
paths:
  - "src/app/**"
  - "src/components/**"
  - "src/lib/ui/**"
---

# Rules: pages and charts (Overview, /trends, /insights, /accounts, /providers)

Evidence: docs/conventions/ui-and-pages.md. Read it before changing anything
below. The rules for every rendered surface (phone width, dates, em dash,
headings, uncertainty, SVG titles) are in CLAUDE.md; the ledger's own are in
ui-ledger.md.

Every page:
- A database that cannot be REACHED is named on the page in both modes, never
  dropped to the generic boundary, naming no culprit and never implying the
  data is gone.
- An /insights archive row is a NAME plus a column of FACTS
  (`InsightRow.facts`), never a punctuated sentence, and a chip that only
  repeats its group heading is null, the tone carried by a mark.

Charts:
- Any axis whose length grows with history thins labels from the END and
  carries a year band.
- Two charts with different ranges: the shorter one names its own range and
  the reason, always.
- niceTicks guarantees last tick ≥ max; value labels are collision-checked.
  A viewBox scales its TYPE with its container, so width buys legibility and
  then overshoots — every /trends chart is capped at 880px for that reason.

Overview:
- Overview's net-worth HEADLINE is LIVE (the signed sum of account
  balances) and carries NO month label; the MoM delta and market-movement
  lines are context from the latest COMPLETE month's NET_WORTH_GROWTH row
  and carry that month's name, surviving its absence. The spending block
  shows the month being LIVED IN; empty says "nothing recorded yet" plus a
  quiet prior-month link, and every printed total is spendingBreakdown's.
- Overview is HEADLINE → DETAIL → TOTAL; the grouping figures are a
  full-width band BELOW the table, never rows inside it; freshness is a
  COLUMN.
- Overview's review panel renders in BOTH states — "all clear" must be
  stated, not implied by absence; the three-level staleness escalation is
  deliberate.
- Overview's ring names every category at ≥3% (eight legend rows max, the
  last being Other, drawn NEUTRAL); /trends' pie names seven, folding the
  rest into a NEUTRAL `Other · N`.

/trends:
- /trends stacks its cards FULL WIDTH in the operator's order: This month so
  far, What changed (last month vs the one before), Build your own (income by
  month, this year so far, as bars), Net worth. Changes are DOLLARS, never a
  ratio column. Defaults live ONCE (B_DEFAULTS/E_DEFAULTS in
  ui/trendsParams.ts), and a link meaning spending says `e.show=spending`.
- A /trends card leads as Overview does: ONE money-face figure over a faint
  context line, then the detail; no figure is printed twice on a card (the
  chart readout IS the legend), and "view as" offers only what the data's
  SHAPE allows (a pie never for months), remembered per card in URL + cookie.
- Comparisons use COMPLETE months, except "this month so far", which cuts
  last month at the same DAY; a card names accounts whose records begin
  inside the earlier span, by first-transaction day.

/insights, /accounts, /providers:
- /insights LEADS with one figure, the month's spending: projected (with
  its chip) for the month being lived in, spent so far while pace refuses
  (said in words), the analyzer's total for a closed month. Its context
  line is the pace paragraph; never print that paragraph again below.
- /insights admits the month being LIVED IN before it has rows — and ONLY
  that month — and DEFAULTS to it, because every current-gated panel (goals,
  readiness, pace, commitments) lives there. Prior months stay one ‹ away.
  The empty month says "nothing recorded yet", never "nothing needs your
  attention" — all clear cannot be told from not checked. ONE `now` drives
  both admission and the current-period gate, or a render straddling UTC
  midnight splits them.
- Per-account "Nd behind" measures against the LAST SYNC, never against now.
- /providers' "This instance" block owes the same three parts a connector
  card does, residual risks included, and states the sync CADENCE, read from
  vercel.json so it cannot drift (the CLOUD data-locality HARD RULE).
