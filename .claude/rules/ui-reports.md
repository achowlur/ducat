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
- Close to a free limit (80% spent, or on pace to pass it), a warn-token
  BANNER sits above every page (UsageAlert in the root layout), read through
  a ten-minute per-instance cache, silent on any failure.
- A database that cannot be REACHED is named on the page in both modes, never
  dropped to the generic boundary, naming no culprit and never implying the
  data is gone. A host that REFUSES on its usage limit (Turso's "BLOCKED:")
  says so, the one cause it names because the host itself named it.
- An /insights archive row is a NAME plus a column of FACTS
  (`InsightRow.facts`), never a punctuated sentence, and a chip that only
  repeats its group heading is null, the tone carried by a mark.
- A recurring row's day prints without its year only inside the year on
  screen; under "No longer charging" it always carries it (shortDateYear).

Charts:
- Any axis whose length grows with history always names its NEWEST month
  (and year), thins the rest (from the end, or on calendar steps where it
  zooms: lib/ui/timeAxis.ts) and carries a year band; no label is clipped.
- Two charts with different ranges: the shorter one names its own range and
  the reason, always.
- niceTicks guarantees last tick ≥ max; value labels are collision-checked.
  A viewBox scales its TYPE with its container, so width buys legibility and
  then overshoots — every /trends chart is capped at 880px for that reason.
- A line that crosses zero floors its axis at its lowest value, never a
  rounded tick below it (valueAxis): $0 stays near the base, a month below
  zero dips under it, and any wash is drawn to zero.

Overview:
- Overview's net-worth HEADLINE is LIVE (the signed sum of account
  balances) and carries NO month label; its context is ONE line from the
  latest COMPLETE month's NET_WORTH_GROWTH row, carrying that month's name
  and surviving its absence: the delta, then markets, saved, any accounts
  joining and the net (growthBetween, adding up exactly), never behind a
  tap. The spending block
  shows the month being LIVED IN; empty says "nothing recorded yet" plus a
  quiet prior-month link, and every printed total is spendingBreakdown's.
- Overview is HEADLINE → DETAIL → TOTAL; the grouping figures are a
  full-width band BELOW the table, never rows inside it; freshness is a
  COLUMN.
- Overview's review panel renders in BOTH states — "all clear" must be
  stated, not implied by absence; the three-level staleness escalation is
  deliberate.
- Overview's net worth row carries "Do this next" (ui/nextAction.ts): the ONE
  most urgent action another page already asks for, ranked in one tested
  table (a deadline or money at risk, then idle money, then tidying), each
  candidate from its own page's code (goalInputs, recurringAlertsFor,
  staleAction), never measured twice; the lead is not printed again in Needs
  review or the stale alert, and with none the slot is EMPTY (Needs review
  states the all clear), net worth taking the row. Mark
  done (Setting nudges.done, {key, at}) hides a nudge until data NEWER than
  the click arrives for what it is about (an account's balanceDate, never
  merely a sync), then the data decides again.
- Overview carries a RECAP on days 1 to 7 of a month (UTC) only, below the net
  worth row: the closed month's spending against the middle of the comparable
  months before it, net worth's saved and markets (growthBetween, "joined"
  named when nonzero) and the net worth goal's date and shift, else the first
  savings goal's. A recap, never an ActionAlert; its reads ride inside the
  page's one Promise.all and exist only on those days (ui/monthRecap.ts).
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
- Net worth ZOOMS by gesture, never by preset buttons: pinch (two fingers
  also move along), Ctrl/trackpad-pinch wheel, drag; a plain wheel scrolls
  the page. The figures above follow the months on show: growth splits into
  markets (the months' own marketGains), accounts JOINING the total (a
  month counting different accounts from the one before, named apart in
  text) and saved (the rest), adding up exactly, and no ratio is printed
  from the first month on record.
- Zoomed in past three months where days are on record, the line goes on
  into DAYS (ui/dailyNetWorth.ts), and zoomed out past them back to months:
  a day is every account's balance by its LOCAL day (localDayKey), each
  bank's last one carried up to CARRY_DAYS (3), a day beyond that LEFT OUT
  and named; the record starts at the first full week every account
  reported; an aggregator-fed brokerage's balance values the PREVIOUS
  trading day's close and is dated a day back (`priorClose`), so a point
  follows its market day and a transfer counts on its own date. Never a
  balance reconstructed from trades. A balance's "as of" anywhere is the
  LOCAL day of the bank's instant (localDayKey, shortLocalDay), never its
  UTC date.

/insights, /accounts, /providers:
- /insights is THREE questions, in order: This month (the spending figure,
  then what is worth a look, anomalies the digest did not lead with in the
  same list), Goals (net worth first, house readiness under the goal that
  funds it), Recurring charges (ONE list: a live plan's next charge leads
  its facts, the next 30 days totalled on top, lapsed plans folded away).
  Net worth, cash flow and spending rows belong to /trends, never printed
  here (the nav carries the way there).
- A goal leads with WHEN: a date band that is its chart's legend, then its
  path (record solid in ink, each projection dashed in Trends' saved or
  markets colour, ending in a dot at the target), readable by tap or drag
  at any month; the working-out folds, anything to discount stays in view.
  Below the chart, in view: the controls (a few words each), lines that
  ask for an ACTION, one line of assumptions; everything else is behind the
  tap. Never hover: it does not exist on a phone.
  A savings goal's record spans only its pace window and ends at TODAY's
  balance, where its projection starts (goalFunds.ts); a chart of three
  years or less is labelled by quarter (timeAxis.ts, goalAxisTicks).
- /insights LEADS with one figure, the month's spending: projected (with
  its chip) for the month being lived in, spent so far while pace refuses
  (said in words), the analyzer's total for a closed month. Its context
  is ONE line in view (spent so far, what a typical rest of the month adds,
  any caveat to discount); how it is worked out is behind a tap, and never
  printed again below.
- /insights admits the month being LIVED IN before it has rows — and ONLY
  that month — and DEFAULTS to it, because every current-gated panel (goals,
  readiness, pace, commitments) lives there. Prior months stay one ‹ away.
  The empty month says "nothing recorded yet", never "nothing needs your
  attention" — all clear cannot be told from not checked. ONE `now` drives
  both admission and the current-period gate, or a render straddling UTC
  midnight splits them.
- /accounts LEADS with the table (operator, 2026-10-19): no net worth headline,
  no last-sync line, no how-counted tap; net worth is the total row at the
  foot, and freshness is each row's chip and age text plus the stale alert.
- Per-account "Nd behind" measures against the LAST SYNC, never against now,
  and never labels a statement-only (CSV/PDF) account (pollsForBalances).
- Net worth says in TEXT what a month estimates or leaves out (Trends names
  each left-out account and its last such month; Overview and /insights count
  them): a month missing an account is smaller than the truth.
- /providers' "This instance" block owes the same three parts a connector
  card does, residual risks included, and states the sync CADENCE, read from
  vercel.json so it cannot drift (the CLOUD data-locality HARD RULE).
- /providers' free-plan limits are COUNTED by the app, never read from a
  host's account API; each limit is a constant dated LIMITS_CHECKED, and
  whatever the count cannot see (other databases on the account, statements
  Turso did not report, a month counted partway) is said in view.
