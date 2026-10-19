---
paths:
  - "src/lib/insights/**"
  - "src/lib/health/**"
  - "src/lib/rates/**"
  - "src/lib/ui/{liquidity,insights,insightRows,periodNav,recurring}*.ts"
  - "src/app/insights/**"
  - "scripts/{set-goals,set-readiness,set-cash-accounts,audit-subscriptions,audit-figures}.ts"
---

# Rules: goals, subscriptions & insights

Evidence: docs/conventions/goals-and-insights.md. Read it before changing
anything below; several entries record "tried and failed, don't retry".

- Renewal stepping: clamp to the month's last day and step from the ORIGIN —
  Date.UTC normalises impossible days instead of clamping.
- Subscription charge matching prefers charges NEAR the expected amount;
  detected subscriptions LAPSE after two silent cadence cycles.
- A plan bills at its CURRENT price run (priceRuns: charges within twice
  the plan's own wobble, never under the 2% threshold), in the /yr and the
  next charge, never the all-history median; a rise is news only against the
  run before it, while the new price has billed 3 times or fewer.
- Before it lapses, a detected charge is MISSED once its ACCOUNT's records run
  past the detector's longest gap for the cadence with no charge
  (missedCharge), never by the clock alone: it stays listed, flagged, and
  leaves the commitments and the /yr, as does a registered twin with no newer
  charge of its own.
- Recurring charges opens with at most TWO ActionAlerts (ui/recurringAlerts.ts;
  the rest fold behind a tap), ranked by the plan's yearly cost: a price rise
  still news (Keep, Cancelled) or a missed charge (Still active, Cancelled).
  The answers are Setting recurring.decisions (ui/recurringDecisions.ts), keyed
  by EVERY merchant string a plan folds from: Keep hides the rise until the
  price changes, Still active hides the miss until the plan charges again or
  lapses, Cancelled treats the plan as lapsed (yearly total, commitments, a
  declared twin silenced) until a charge newer than the one it was cancelled
  at. A decision never touches a transaction, and the action finds the plan
  in the SAME live list the page was built from, refusing a stale page.
- A SHARED plan is read from repayments LINKED to its bills, never a typed
  share (insights/sharedPlans.ts, one pure function in the detector, carried
  as RecurringChargePayload.shared): two settled bills in a row repaid makes
  it shared, its share the MIDDLE of recent settled nets as a PART of each
  bill (so a rise split alike stays shared), a half-linked newest bill never
  in it, and every figure reads it through costNow (priceNow stays the bill). Once the next bill
  arrives a short one counts at bill less repaid and asks "Not split" (Link
  repayments, Not shared this month: decision `unshared`, by bill day); two
  short in a row end the sharing silently. Spending is never netted twice.
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
- The pace call projects the REST of the month from what typical months
  spent AFTER this day, EVERYDAY spending only
  (SpendingByCategoryPayload.everydayAfterDay: travel, by category name, and
  the month's one-off purchases, the transaction anomalies, left out, except
  RENT, which a one-off flag never takes out: NEVER_ONE_OFF_CATEGORIES); never
  a share of the month's total, which counts rent paid on the 2nd again on
  the 17th. Spending so far counts everything.
- The NET WORTH goal (ui/netWorthGoal.ts, Setting goals.netWorth) prints
  TWO dates and never one blended rate: by saving alone (the /trends "saved"
  pace over 6 complete months, one-off pay left out, never across a change
  in counted accounts)
  and with markets (a real return the operator SETS, applied to invested
  money outside the cash definition and to the monthly deposit into it, the
  MIDDLE of the last three months: never a mean, a fixed cutoff or a long
  window, and a month that does not match is named; no return lives in
  code). Today's
  dollars; dates from the last complete month-end, each with its shift and
  the pace a month before. Target, return, saving a month and the amount
  invested a month are CONTROLS on the panel: they re-project in the
  browser through projectGoal (the server's own arithmetic) and save when
  they settle; a shift always compares the SAME settings a month apart;
  with no return set the slider sits at 0. Each monthly figure defaults to
  the measured one and follows it; typing the measured figure clears it.
  The saving is the TOTAL and the investing only SPLITS it (withSaving;
  the fields read "Saved per month" and "Of which invested", the rest
  named as staying cash),
  except that investing typed ABOVE the saving raises the saving to match;
  investing above a saving lowered after says, in the warning ink, that the
  rest comes out of cash and how long it lasts, and the projection invests
  only cash there is (never below zero). The dates stay in TODAY'S dollars, never nominal; what
  that assumes (saving rising with inflation) is SAID, at an ASSUMED 3%,
  with the deposit checked against a year ago (keepingUp). CASH earns its
  MEASURED yield less that 3%: each cash account's yield from the interest
  and dividends it was PAID (NetWorthGrowthPayload.interestByAccount, the
  middle of its last three months against its month-start balance), NEVER
  its change in value; cash HELD earns at the month-end mix, NEW saving at
  the mix averaged over the pace window (it waits in checking first); both
  dates use it; a row predating the field holds cash level. Cash beyond a month of SPENDING (never "what leaves the account")
  in accounts paying nothing is named with what the best-paying cash
  account would earn on it (idleCashAt, live balances, IDLE_CASH_MIN).
- ONE-OFF PAY (insights/oneOffPay.ts, CashFlowTrendPayload.oneOffIncome) is
  EXTRA pay from a payer with a salary-like run: beside a regular paycheck,
  or between two paydays no further apart than usual. Regular = the same
  amount (within 2%) on 3 of the 8 paydays around it; a deposit standing
  where a paycheck should be IS the paycheck; interest and dividends are
  never judged. It stays in income and cash flow but is LEFT OUT of every
  saving pace and of readiness income, and the screens say so. A deposit
  where a paycheck should be IS the paycheck, a raise counting the day it
  lands; a bonus beside one never asks and never reads as a raise. Income
  from NO REGULAR SOURCE is one-off too (irregularIncome: a source paying
  in under 3 of the 7 months around it; a payment rail is never a source),
  and readiness income also leaves out what the FUND itself earns
  (CashFlowTrendPayload.earnedByAccount).
- The paces project from pay as it is NOW (ui/payLevel.ts): once a new
  paycheck amount repeats, or the operator presses "This is my new pay"
  (Setting pay.newPay), every earlier paycheck counts at it (a cut too);
  until then the new amount counts as itself and the panel asks. A JOB
  CHANGE (a payer silent two of its cycles and 35 days, ONE payer starting
  after its last payday) counts the old job's months at a MONTH of the new
  pay; one new paycheck, or several new payers, ask through the same button;
  two payers at once are two jobs.
- "Counts as cash" is a Setting (cash.additionalAccountIds via
  accounts:cash), never an account-type change — retyping breaks net worth.
- npm run goals --add is NOT idempotent (slugs dedupe, content does not):
  read the printed listing before adding.
- The goals panel is gated to the month being lived in; the period selector
  clamps to months with rows PLUS that month (selectPeriod in
  ui/periodNav.ts), so the panel renders from day 1 and its absence means
  the Setting is missing, not the month.
- The savings pace, readiness and the runway average the last six complete
  months LESS any under the pace call's comparability bar (recentMonths.ts,
  isComparableBaseline), never reaching further back; a month kept that
  predates an account's records entirely is NAMED, with the way it leans.
- The runway and a CASH goal count cash AFTER open card balances
  (BalanceSummary.cards; loans aside), said in their assumptions line; the
  runway divides by the MIDDLE of the window's EVERYDAY months
  (everydayAfterDay[0]), never a mean of totals, and a credit against a
  one-off leaves the everyday series with it.
- A change to any projection is read back with `npm run audit:figures`
  (a COPY of the newest verified backup, regenerated with the branch's
  code, never DATABASE_URL) before it ships; its output is real figures and
  stays out of every public text.
- A savings goal's "Saved per month" is the net worth goal's field on the
  card: Setting goals.savings entries take an OPTIONAL `monthlyPace` (absent
  follows the measured pace; typing the measured figure clears it; an
  unreadable one is ignored, never a dropped goal), written only through
  withGoalPace on the raw entries, and the card re-projects through
  projectLanding, the server's arithmetic. A goal landing AFTER its target
  month shows ONE ActionAlert (BEHIND) with the field inside it, "Save ~$X/mo
  more", X from extraToLand (the inverse of projectLanding, rounded UP to
  $10); on time, ahead, no target month, no pace or under a month left: no
  alert, the field sits in the controls.
- A cash goal prints its RECONCILIATION beside the projected landing —
  observed cash growth over the same window the rate averages — because the
  rate assumes every saved dollar stays in cash, and with a single goal
  nothing else states that assumption. Never remove it to "declutter".
  It is measured from the fund's month-end BALANCES (goalFunds.ts), never
  a sum of its transactions: an investment account counted as cash books
  trades and sweeps as rows.
- House readiness LEADS with the verdict on the target house (its cash, when
  the fund reaches it, its payment against the budget, over in the warning
  ink), then what the plan affords today with the binding ceiling named; the
  budget ledger and both ceilings are behind a tap. Estimates print in whole
  dollars or $k, never cents.
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
