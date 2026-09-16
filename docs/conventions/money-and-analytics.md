# Ducat — money & analytics conventions

> Figures in this file are not real. Those present at publication are scaled by one unrecorded constant, so their ratios are exact; any added since are invented. See [publishing.md](publishing.md).

Moved VERBATIM from CLAUDE.md on 2026-08-01 (the split). This file holds the
full evidence — what each rule cost and why alternatives failed. The one-line
enforceable rules live in CLAUDE.md and point here. Additions follow the same
contract: rule line in CLAUDE.md, evidence here, never both in one place.

- MANUAL categorization is sacred, and rules are not the only thing that can
  overwrite it. Transfer-pair detection rewrites flow to TRANSFER and nulls the
  category, so it EXCLUDES manually-categorized rows: a $139.95 dinner you
  categorized and a $139.95 repayment two days later look exactly like a transfer
  pair, and the expense would vanish from every spending total. Any future path
  that rewrites flow/category must make the same exclusion.
- Analyzers legitimately emit NOTHING (net worth refuses periods it can't know;
  a CSV-only import writes no BalanceSnapshot at all), so every consumer must
  survive an empty series. `/trends` returned a 500 on first run because
  `NetWorthChart` indexed `months[-1]` and took `Math.max()` of an empty array,
  and the page gated on SPENDING_BY_CATEGORY while net worth comes from a
  different insight type. Guard the series, don't assume the gate covers it.
- Reimbursements can push a category NEGATIVE (deliberate, and tested), and
  three money bugs grew out of that one fact. (1) Shares and arcs divide by
  `drawable`, the categories with net spending — a negative shrinks the
  denominator while drawing no arc, so slices summed past 100% and overlapped.
  (2) Every PRINTED total is the net `totalSpending` that /insights and the
  cash-flow row report; printing `drawable` as the donut headline gave June two
  totals ($3,535.25 on /trends, $3,125.52 on /insights). Both donuts now come
  from `ui/spendingBreakdown.ts` so the two screens cannot drift again.
  (3) `pctDelta` returns null when EITHER operand crosses zero — a sign flip is
  not a percentage change, but it rendered as one in the boldest style on the
  page ("Rent & Housing ×13.4", from June's −$409.73 refund). Category lists
  still show negatives honestly; a negative shows "—" for share, while
  "new" keeps its own meaning of no prior row at all.
  The guard shipped against the DIVISOR alone (`previous <= 0`) and the mirror
  case survived it for two months, because the fix was written from the example
  rather than from the arithmetic. A POSITIVE base with a NEGATIVE current is
  the same flip walked the other way: October 2025's Rent & Housing came to
  −$3,353.00 against a positive September and printed **−127.80%** — a spending
  cut of more than 100%, in `font-semibold text-pos`, the loudest green on the
  page, i.e. the strongest "improvement" signal on /trends sitting on a row
  whose own figure was negative. You cannot reduce spending by more than you
  spent. `current < 0` now returns null too (2026-08-03), which also covers
  `cashFlow.ts`'s income/spending deltas, where the same division was reachable
  in a net-refund month and would have read as prose.
  A third refusal needed a third WORD, not a third use of the dash. `vs prev`
  and `Share` sit in adjacent cells and "—" already meant "this category ended
  in credit" in the second; reusing it for "the current period ended in credit"
  in the first would have made one glyph mean three things across two columns
  with no key on the page. So /trends now distinguishes them in words: `new`
  (no prior row at all), `—` (prior base not positive, nothing to divide by),
  `refunded` (current period ended in credit). The em dash's own overload
  across the two columns is still open — see docs/backlog.md.
- Net worth history requires SNAPSHOTS, not transactions. `balanceAt`
  (insights/netWorth.ts) returns `known:false` for an INVESTMENT account with no
  snapshot at/before the date, and `computeNetWorthGrowth` emits NOTHING for a
  period it can't fully know — a net worth missing an account is not a smaller
  net worth, it's a wrong one. Reason: market movement leaves no transaction and
  every "YOU BOUGHT" is cash leaving with no entry for what it bought, so
  rolling today's balance backward through trades fabricates the past (it once
  reported net worth DECLINING from $707.54k in 2024-06 to $684.22k today, the
  opposite of the truth). Rolling one FORWARD is the same fiction, so a
  snapshot only counts for a period if it falls INSIDE that period
  (`investmentSnapshotNotBefore`) — carrying an August month-end into September
  ignores a month of market movement. Cash/credit are exempt: transactions
  fully explain them. So ONE month-end snapshot per investment account unlocks
  exactly that month; `npm run import:balances -- --template` emits a fill-in
  template for every uncovered month (usage in the script's own header). History
  otherwise grows one snapshot per sync. `marketGains` only computes once two
  consecutive periods are snapshot-backed.
- `investmentNetFlows` counts ONLY money crossing an investment account's
  boundary. Buys, sells, dividends and reinvestments move nothing in or out, and
  counting them turned a real ~$2.5k month into a reported $64.79k one. Classified
  by excluding internal verbs (a small stable set) rather than listing transfer
  descriptors (which vary by institution), so anything unrecognised counts as a
  flow and understates gains rather than inflating them. DIRECTION comes from the
  wording, not the sign: the same monthly transfer arrives +1400 from Fidelity's
  CSV and -1400 from SimpleFIN, so only the magnitude is trusted.
- Sources disagree, so never trust one connector's convention alone. Fidelity's
  CSV and SimpleFIN sign the identical transfer oppositely; SimpleFIN reports
  trades as plain OUTFLOWs while the CSV mapping flags them TRANSFER. Anything
  that reads transaction amounts for an investment account must be robust to
  both.
- The sweep into a Fidelity account's core money-market position is INTERNAL
  activity — not income, and not a transfer between accounts (2026-09-16).
  After every cash arrival the SimpleFIN feed adds a line "PURCHASE INTO CORE
  ACCOUNT <core fund> (Cash)", payee Fidelity, sometimes marked "MORNING
  TRADE", for the same total as the cash that arrived. It is the movement the
  pack already marks TRANSFER when it arrives worded "REINVESTMENT": cash
  changing form inside one account, crossing no boundary. The two wordings
  disagree on the SIGN between accounts — the reinvestment line arrives
  negative, the core purchase positive — so nothing about the sign identifies
  it, and nothing covered the second wording. Unmarked, each sweep did damage
  three ways: it counted as INCOME in the cash-flow trend; it counted as money
  CROSSING the boundary in the net-worth attribution, understating market
  gains; and it was a transfer-pair CANDIDATE, the same amount on the same day
  in another account from the funding debit, tying with the real deposit — so
  pairing could link the debit to the sweep and leave the deposit counted as
  income instead. Fixed by the WORDS: a flow-only DESCRIPTION rule beside the
  reinvestment one (whose shipped value is never edited), and "purchase into
  core" among netWorth's internal-activity verbs. Rules run before pairing and
  pairing skips rows already TRANSFER, so a sweep classified at import leaves
  the candidate set and the debit can only meet the deposit. History is only
  partly repaired by installing the rule: `npm run upgrade` reclassifies every
  sweep that sat unpaired, but reapplying rules never touches a transfer pair,
  so a debit already linked to a sweep stays linked and its deposit stays
  income until that pair is undone.
- Anomaly baselines use only periods where the category actually had spending
  (`anomalies.ts`). Counting empty periods as $0 makes the median 0 for any
  category whose data starts partway through history — which, with accounts
  reaching back different distances, was everything — so every ordinary month
  scored as an infinite deviation and reported "vs $0 in a typical month".
  Rent, the most predictable expense there is, was flagged every month.
- Anomalies RANK, they don't threshold. `deviation` decides which one survives
  and the threshold only decides eligibility: `maxPerBaseline: 1` reports the
  most unusual transaction per category (per merchant when uncategorized) per
  period, ties broken on amount because a constant history caps every z at 99.
  Before that the analyzer emitted everything above the line, which on real data
  meant 114 of 132 transaction anomalies were Dining and one month had six
  restaurant meals. The composition was HONEST — 321 of 470 outflows were Dining
  — so no statistic fixed it: higher z, p90, p95 and absolute floors all left
  Dining at 76-86%, and the tighter ones destroyed the findings worth having
  (p95 dropped a $1707.95 one-off; a $100 floor dropped a $95 annual card fee AND a
  $186.6 advisory fee). Also: displayed magnitude is a RANK, not a ratio —
  `percentileOfHistory` renders as "higher than 96% of your Dining" via
  `higherThan()`, rounded DOWN. "4.3× typical" invited reading the median as what
  a dinner costs when 56% of Dining is under $51.83. Tried and failed, don't retry:
  preferring a transaction's own MERCHANT history over its category moved 51 to
  50, because dining spreads across many restaurants and almost none reaches
  five prior visits.
- Anomalies also need a RANK GATE, because a robust z-score assumes ONE
  population and a category can be two. Moving a rent portal's $7.78 convenience
  fee into Rent & Housing left 12 fees beside 11 rents; the median ($170.02)
  described neither, so every rent scored z=36 against a "typical" of $88.95
  and was reported as extraordinary — the exact symptom the active-period
  baseline rule was written to kill, arriving by a different route.
  `minPercentile: 0.85` is an ELIGIBILITY gate and changes no ranking: z still
  picks the winner per baseline, and anything both unusual AND rare is
  untouched. Measured over 2638 real transactions it takes rent from 9 findings
  to 1 — a $4,773.73 payment genuinely higher than 90% of its category — while
  keeping the $1707.95 one-off and the $186.6 advisory fee. 0.9 kills the advisory fee,
  which is why the bar is not higher. It is also self-consistency: the UI prints
  the percentile AS the justification, so a finding reading "higher than 67% of
  your Rent & Housing" was refuting its own headline. Tried and failed first,
  don't retry: LOG-SPACE median/MAD. It is the theoretically appealing fix for
  a heavy-tailed multiplicative quantity, and it destroys the good findings
  before it touches rent — at z>=2.5 rent goes but the $1707.95 one-off and the $186.6
  advisory fee go with it, and at z>=2.0 rent survives all 9 times.
- A coverage gap is TWO claims, not one, and `CoverageNotice` made only the
  harsher one. An account that STARTED MID-PERIOD is in the totals and known to
  the penny — nothing is missing, the period merely is not comparable with
  earlier ones. An account with NO DATA for the period understates it by an
  amount nobody can compute. The first version said "totals here exclude
  <account>", which was FALSE for the first case, and reported a COUNT of
  accounts rather than an amount — so a transit card holding $104.32 of a
  $11,009.59 month raised the same amber banner a missing mortgage would.
  `periodCoverage` now classifies each gap and sums the known contribution;
  only NO_DATA earns amber. Report dollars, not account counts: the magnitude
  is what tells the reader whether to care, and it needs no tuned threshold to
  decide for them.
- Data coverage (`src/lib/insights/coverage.ts`): accounts have different
  history depths (a 90-day feed vs an 18-month CSV vs 5 years of brokerage
  history), so periods before an account's first transaction are UNDERSTATED,
  and the month its history starts looks like a spending spike that never
  happened. `periodCoverage` quantifies this and `CoverageNotice`
  surfaces it on Trends/Insights — visibly incomplete beats silently wrong.
  An account counts as covering a period only if its first transaction is at
  or before the period START (mid-period starts are partial).
- Reimbursement suggestions lead with AMOUNT evidence (exact, clean 1/n, or a
  rounded ≈1/n — people send $62.2 for a $61.55 share); date proximity only breaks
  ties. Ranking by date alone put last night's rent above the dinner a $116.63 Zelle
  actually repaid. Categories in `UNSPLITTABLE` are denied split evidence:
  arithmetic can't tell "1/5 of a dinner" from "1/6 of a tax bill".
- Trip grouping (2026-08-02) exists to answer "what did the March trip cost"
  without any month lying, and the whole design is that it is a VIEW: one
  nullable `groupLabel` on Transaction — deliberately the exact shape
  `schema:push` can ADD to a populated table (nullable, no default; the
  delta classifies additive at any row count, twice-derived independently)
  — read by nothing in `insights/`. The spine test
  (`sync/groupLabel.test.ts`) seeds a database through runSync, snapshots
  generateInsights output and every spendingBreakdown, tags rows of every
  shape (RULE, MANUAL, both transfer sides, a linked reimbursement, a
  second month), regenerates, and asserts deep-equal — and it now STATES
  which analyzer types its fixture empirically pins (CASH_FLOW_TREND,
  NET_WORTH_GROWTH, SPENDING_BY_CATEGORY); the anomaly/recurring family is
  protected by the zero-reads grep discipline, and if that type set ever
  moves the boundary moved with it — re-decide, don't just update the list.
  The undo half was made testable by extracting `restoreTransactions` into
  rulePack.ts: the restore writes exactly categoryId/categorySource/flow,
  so the snapshot deliberately does NOT carry groupLabel — a tag applied
  between a bulk decision and its undo survives the undo, the
  MANUAL-is-sacred reasoning pointed the other way, and the adversarial
  review found no reachable sequence that loses a tag (the only writer is
  setTransactionGroup; dedup never touches an existing row). TRANSFER rows
  may carry a tag; the band and the TRIPS section sum the signed net of the
  rows their own view shows, transfers included, because a summary that
  disagrees with the table under it is the two-totals bug — and each says
  so in words while spending analytics keep excluding those rows entirely.
