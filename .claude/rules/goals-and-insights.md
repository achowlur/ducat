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
