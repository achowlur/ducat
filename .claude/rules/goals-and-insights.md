---
paths:
  - "src/lib/insights/**"
  - "src/lib/health/**"
  - "src/lib/rates/**"
  - "src/lib/ui/{liquidity,insights,insightRows,periodNav}*.ts"
  - "src/app/insights/**"
  - "scripts/{set-goals,set-readiness,set-cash-accounts,audit-subscriptions}.ts"
---

# Rules: goals, subscriptions & insights

Evidence: docs/conventions/goals-and-insights.md. Read it before changing
anything below; several entries record "tried and failed, don't retry".

- Renewal stepping: clamp to the month's last day and step from the ORIGIN —
  Date.UTC normalises impossible days instead of clamping.
- Subscription charge matching prefers charges NEAR the expected amount;
  detected subscriptions LAPSE after two silent cadence cycles.
- Before it lapses, a detected charge is MISSED once its ACCOUNT's records run
  past the detector's longest gap for the cadence with no charge
  (missedCharge), never by the clock alone: it stays listed, flagged, and
  leaves the commitments and the /yr, as does a registered twin with no newer
  charge of its own.
- The detector follows ONE plan across a renamed descriptor (continues in
  recurring.ts): same account, no overlap, about the same price, a shared
  NAME word (payeeWords.ts, never a town), and a handover gap like any other
  cycle; it keys on the newest name, lists the rest as `aliases`, and never
  assembles a plan from names none of which is recurring alone.
- Registered subscriptions fold to charges by their OWN merchantPattern
  (matchesSubscription) — never brandOf; detected wins ties.
- Subscription thresholds are TUNED: run subs:audit before touching one and
  expect the answer no; the audit mirrors the detector's gates — change
  recurring.ts and the audit together.
- Recurring is NOT subscribed: NOT_SUBSCRIPTION_CATEGORIES excludes by
  CATEGORY, not by merchant name.
- A finding the DIGEST leads with is not printed again below it: items carry a
  dedupeKey (anomalyDedupeKey, computed on both sides) and the Anomalies group
  is filtered by the keys the digest KEPT. The promoted row carries the rank,
  so nothing is lost.
- Category DRIFT is measured NET of that period's one-offs in the category —
  a one-off is scored once, never annualised as a trend.
- Baselines are RECENT, never all history: drift against a category's last
  12 periods with spending, the pace call against the same month of the last
  3 years (else the trailing 3 months). On a long history every price or pay
  rise otherwise reads as a trend all the year after it.
- The NET WORTH goal (ui/netWorthGoal.ts, Setting goals.netWorth) prints
  TWO dates and never one blended rate: by saving alone (the /trends "saved"
  pace over 12 complete months, never across a change in counted accounts)
  and with markets (a real return the operator SETS, applied to invested
  money outside the cash definition and to the monthly deposit into it, the
  MIDDLE of the last three months: never a mean, a fixed cutoff or a long
  window, and a month that does not match is named; no return lives in
  code). Today's
  dollars; dates from the last complete month-end, each with its shift and
  the pace a month before. Target and return are CONTROLS on the panel:
  they re-project in the browser through projectGoal (the server's own
  arithmetic) and save when they settle; a shift always compares the SAME
  target and return a month apart; with no return set the slider sits at 0.
- "Counts as cash" is a Setting (cash.additionalAccountIds via
  accounts:cash), never an account-type change — retyping breaks net worth.
- npm run goals --add is NOT idempotent (slugs dedupe, content does not):
  read the printed listing before adding.
- The goals panel is gated to the month being lived in; the period selector
  clamps to months with rows PLUS that month (selectPeriod in
  ui/periodNav.ts), so the panel renders from day 1 and its absence means
  the Setting is missing, not the month.
- A cash goal prints its RECONCILIATION beside the projected landing —
  observed cash growth over the same window the rate averages — because the
  rate assumes every saved dollar stays in cash, and with a single goal
  nothing else states that assumption. Never remove it to "declutter".
  It is measured from the fund's month-end BALANCES (goalFunds.ts), never
  a sum of its transactions: an investment account counted as cash books
  trades and sweeps as rows.
- House readiness is a READINESS signal, never lender math: the residual
  form (income − non-housing − declared floor) is canonical, non-housing is
  built PER MONTH before averaging, the binding ceiling is named
  FUND-limited (never "deposit-limited"), typed assumptions collapse behind
  ONE tap-to-open ASSUMED disclosure whose summary keeps the rate's as-of
  date visible (a hidden rate must never read current forever), and NO
  default rate lives in code — absent `readiness.house` config, or no
  declared goal to be the fund, means no panel.
- The readiness rate resolves TYPED-FIRST: a typed rate always overrides
  the fetched index; rate-absence is entered only via --fetched-rate; an
  operative fetched rate names FRED and its series in the ASSUMED summary
  and dates itself by the OBSERVATION date; no typed rate + no stored
  observation = no panel, no invented rate.
