# Ducat — backlog and recorded designs

Moved VERBATIM from CLAUDE.md on 2026-08-01 (the split). This file holds the
full evidence — what each rule cost and why alternatives failed. The one-line
enforceable rules live in CLAUDE.md and point here. Additions follow the same
contract: rule line in CLAUDE.md, evidence here, never both in one place.

## Backlog (agreed 2026-07-27, investigated, not yet built)

**Rebuild /insights as "am I on track?" — DESIGNED 2026-07-27, BUILT 2026-07-28.**
All four slots ship (`insights/digest.ts`, `insights/pace.ts`,
`health/commitments.ts`) and decision 1 is implemented: Overview carries state
only. The design below is kept because it is what constrains changes to it.
The diagnosis first, because it is not what it looks like: the
analyzers are fine. They are the most hardened code in the repo. The problem is
that the TAB HAS NO EXCLUSIVE CONTENT — every insight type it renders has a
better home elsewhere (SPENDING_BY_CATEGORY and CASH_FLOW_TREND on /trends,
NET_WORTH_GROWTH on /trends and Overview, RECURRING_CHARGE on Overview with its
annualised total, ANOMALY on Overview's signals). And `GROUPS` is keyed by
`InsightType`, so it is organised around the ENGINE'S DATA MODEL rather than a
question anyone asks. Every other tab answers something a person wants — how am
I doing / how has this changed / what exactly happened / what do I have / can I
trust this — and this one answers "what did the engine compute".

Also settled: the "Ducat observes, it doesn't model" framing is WRONG and
should not be repeated. The app already models and already projects —
`annualisedTotal` is a forecast, `isActive` predicts a charge that didn't
happen, renewal dates are stepped forward, anomalies are median/MAD inference,
`marketGains` is attribution. The principle it actually holds is narrower:
NEVER ASSERT WHAT THE EVIDENCE CANNOT SUPPORT, REFUSE RATHER THAN FABRICATE
(`known:false`, active-period-only baselines, `pctDelta` null on a base ≤ 0).
That permits projection and constrains it — and the lapse bound proves the
point: when `annualisedTotal` billed a cancelled Netflix forever, the fix was
to bound the projection by evidence, not to stop projecting.

The design, so it is not re-derived:

- **One question: "am I on track, and what needs attention?"** Backward and
  forward are not two sections stacked — THE FORWARD CLAUSE IS WHAT EARNS A
  CHANGE ITS PLACE. "Dining up 34%" is a number; "up 34%, third month rising,
  ~$2,850.9/yr if it holds" is a decision. Anything that cannot state a forward
  consequence probably does not belong, which is also the filter that stops
  this becoming noise.
- **Four slots, each refusing independently.** (A) where this month lands —
  spent so far, still committed, what comparable months ran, on pace for.
  (B) what changed, ranked across types, each with its consequence. (C) what is
  already committed in the next 30 days, with dates. (D) "nothing needs
  attention this month", explicitly and often.
- **Rank slot B by DOLLARS AT STAKE over the next twelve months, not by
  statistical unusualness**, with deviation only as a tiebreak. A 4x deviation
  on a $31.1 charge matters less than a 3% drift on rent. This makes the
  projection do work rather than decorate, and attacks the Dining-flood problem
  from a different angle than the anomaly analyzer does.
- **Refusals, reusing what exists:** no pace call before ~25% of the period has
  elapsed (day 3 says nothing); only periods where the category was actually
  active (the anomaly baseline rule); and nothing projected across a period
  `periodCoverage` knows was incomplete. Projections get their own chip and
  explicit wording — the moment a forecast reads like an observation the app is
  asserting what it does not know.
- **Historical periods show the projection BESIDE what happened** — "June: on
  pace for $9,589.4 on day 18, landed at $9,392.43". That makes the forecast
  accountable instead of decorative, is the falsifiability test made visible,
  and gives the existing period selector a real job.

Three decisions, agreed:
1. **Overview narrows to STATE** (balances, net worth, what needs review);
   /insights owns TRAJECTORY. Without this the two tabs answer the same
   question again, which is how the current overlap happened. DONE 2026-07-28 —
   the signals column, the subscriptions block and the price-drift/renewal
   chips are gone, and Overview dropped a query with them.
2. **Slot B is hard-capped at 3-4 items**, as a rule and not a default —
   `maxPerBaseline: 1` is the precedent.
3. **"On pace" compares to the SAME CALENDAR MONTH in prior years**, falling
   back to a trailing average when there are too few. They disagree for
   anything seasonal, and rent-dominated months make a trailing average look
   stable while a December genuinely is not.

Architecture: DO NOT STORE the digest — rank at render from stored insights
plus one new forward analyzer. `generateInsights` runs synchronously inside
server actions (the 4.1s lesson), so the digest must not add a pass; reuse the
memoized period bounds and the anomaly analyzer's per-period category buckets.

**Build C FIRST, then A, then B.** C is the forward-commitment number, and the
hard part is already written and correct: `stepForward`/`addMonths` in
`health/subscriptions.ts` already project a next-due date with month-end
clamping, stepping from the ORIGIN so clamps never accumulate. The work is
applying that to DETECTED charges, which today carry only `lastDate` and
`cadence`. It is also the highest-confidence projection the app will ever make
— observed cadence, observed amount, no assumption — which makes it the right
place to establish how projections are chipped, worded and refused before doing
it anywhere riskier. A needs C for its "still committed" clause; B needs both
for its forward-impact ranking and is the highest noise risk, so it goes last,
after decision 1 is implemented.

Five items raised after the cloud deploy, with what investigating them already
turned up so it isn't rediscovered:

- **`/transactions` is 10× slower than every other page** — RESOLVED
  2026-08-02, in two unequal halves (evidence in
  docs/conventions/performance.md): the compute half below was already dead
  (the 2026-07-27 commit “Stop joining categories into the reimbursement pool” had hoisted the projection; the hot path measures 2.5 ms), and
  the live bug was SERIALIZATION — 1047 candidate objects embedded for 99
  pickers nobody opened; candidates now travel on open. Original diagnosis
  kept below. — 0.87s against a
  local FILE database, where `/`, `/trends`, `/insights`, `/accounts` and
  `/providers` are all 0.06–0.09s. Cause located: in `transactions/page.tsx`
  the `candidatePool.map(...)` sits INSIDE `candidatesFor`, which is called per
  inflow row, so 74 inflows × 470 outflows = 34,780 projections per load. Same
  bug class the analyzer pass fixed, hiding in a page component. Cheap fix is
  hoisting the map; the bigger one is computing candidates lazily, since all 74
  are currently computed AND serialized into the HTML even when none is opened.
  Measure in a PRODUCTION build before judging — 0.87s is a dev-mode number.
- ~~Donut navigation~~ — DONE, see the category-filter convention above.
- **Merchant strings are SHATTERED for internal transfers — RE-MEASURED
  2026-07-31, and the answer is LEAVE IT.** Counts are flat to the row against
  the first measurement: `online transfer` 251 merchant strings / 262 rows,
  `fid bkg` (Fidelity ACH) 27 / 27, `zelle to`+`zelle from` 49 / 49, one
  merchant per row because each carries its own reference code. Two facts
  decide it. First the set is FROZEN: every shattered row is `source=CSV`
  (2024-06-28 → 2026-04-26), and the feed took over on 2026-04-27 supplying a
  clean payee for the IDENTICAL descriptor — "FID BKG SVC LLC  MONEYLINE …"
  stores as "fidelity brokerage services" — so in the feed era only 5 of 238
  distinct merchants exceed 30 characters and this cannot grow on its own.
  Second, STORED is not DISPLAYED: running the real `merchantLabel` over all
  2,677 rows, 391 rows display bank bookkeeping but 136 are TRANSFER and only
  SIX non-TRANSFER rows read badly. Zero Zelle rows are among them — 49 stored
  strings collapse to 75 labels, "zelle to tess on ref # wfct0000000m" renders
  "Zelle To Tess". And the damage is all archive: pages 1-2 of the ledger (the
  newest 200 rows) hold zero shattered rows and zero labels over 40 characters,
  while page 10 holds 57 of 100. Every badly-reading row is dimmed at
  `opacity-60`, renders a plain "transfer" span instead of a category control,
  is excluded from every analytic, and carries its full text in the row
  tooltip — the label is decoration on a row that carries no decision.
  The blast radius was simulated and is CLEAN, which is worth recording because
  it means cost is not what stops this: 438 rows rewritten, 0 of 548 MERCHANT
  rule values shortened (the `wf credit card auto pay` hazard is empty here —
  the rules holding these rows TRANSFER are all DESCRIPTION rules, which
  `repair:merchants` never touches), 0 rows changing category or flow, 341
  grouped-review keys unchanged.
  DO NOT SHIP a third marker `authorized on`. "purchase authorized on macy's
  560 7875 plaza springfield il … card 1234" truncates to "purchase", and
  `MIN_MERCHANT = 3` does not refuse it because 8 characters precede — two rows
  lose their merchant outright (Macy's $418.10 Shopping, Bocaview Optical $101.08
  Health). Wells Fargo puts the merchant AFTER the type in that layout,
  inverting the assumption the whole list is built on. Already pinned by
  `connectors.test.ts:97`.
  `ref #` is also not a one-line addition: `TRANSACTION_TYPE` is `\b(a|b|c)\b`,
  and a `ref\s*#` entry inside that wrapper fires only when the bank omits the
  space after `#` — 31 of 166 Zelle rows against 46 for the unwrapped form, same
  bank, same rail, two behaviours decided by a printed space. Correct is a
  LEADING `\b` only, as `payeeKey`'s `NOISE_MARKERS` already writes it.
  What would flip this, in likelihood order: (1) a CSV backfill — "deeper
  history" is on the backlog and CSV is the only path to it, at ~5.6 shattered
  strings per backfilled month; (2) the feed dropping the payee, which one row
  on 2026-04-27 already hints is not stable (it arrived as "wells fargo" for
  the same descriptor shape) — that would put shattered rows on page 1 within a
  month, and it is the thing to watch; (3) any other reason to restructure
  `TRANSACTION_TYPE`'s regex, in which case `ref #` buys 249 of the 319 labels
  at a measured-zero blast radius and is worth doing opportunistically.
  `moneyline` is not worth it either way — it fixes 27 frozen rows and zero
  future ones, and only ever fires for someone backfilling a Wells Fargo CSV
  that contains a Fidelity ACH.
- ~~Another pass on subscription detection~~ — AUDITED, and the answer is
  DON'T. See the recurring-detection convention above.
- **A public demo instance** — DESIGN AGREED 2026-07-27, DEFERRED on purpose.
  Not blocked on anything technical any more; it waits until the app is
  feature-stable, because a demo built against a moving app is a second thing
  to keep in sync and every screen change would have to land twice. Build it
  when the surface stops moving. The design, so it is not re-derived:
  - **Published password, NOT a login-less demo.** The mode-scoped HARD RULE
    requires the auth gate to be CONFIGURED; it says nothing about the password
    being secret. So the demo sets `AUTH_PASSWORD_HASH`/`SESSION_SECRET`
    normally and prints the password on the login page. This needs NO amendment
    to the rule and — the real reason — NO change to `middleware.ts`,
    `mode.ts` or `session.ts`, so a demo bypass that could ever be set on the
    operator's own instance never exists. It also keeps crawlers from indexing
    fabricated financial data, and the login page is the natural place to say
    the data is invented.
  - **Mutable, with a daily reset**, reversing the earlier "genuinely
    read-only" position. What changed: there is no free-text persistence path.
    Categories cannot be created from the UI and rule values derive from
    existing merchant strings, and rule `matchValue` is not rendered anywhere,
    so the worst a visitor can do — POSTing `createRuleFromMerchant("a", …)`
    straight at the server action — is make the demo look wrong until it
    resets. Vandalism is recoverable; offensive content shown to the next
    visitor would not have been. Read-only would also have hidden the best
    parts of the app, which are all mutations (category picker, grouped review,
    reimbursement linking). If it is ever made read-only after all, layer it: a
    read-only Turso token is the actual guarantee, and a write guard on the
    Prisma client is the decent error message — never per-action guards, which
    would be forgotten among 11 server actions.
  - **Two years of history**, ~800-3888 transactions plus ~130 snapshots.
  - The decisive constraint is that demo data DECAYS. Subscriptions vanish once
    `isActive` sees them lapse, "this month" empties at the month boundary, and
    net worth draws nothing without a snapshot INSIDE each period per
    investment account. So fixtures must be generated RELATIVE to today and
    regenerated on a schedule — which means the reset job is required whether
    or not the demo is mutable, and is what makes mutability nearly free.
  - Its own Vercel project and Turso database, no `SIMPLEFIN_ACCESS_URL`, and
    it should REFUSE TO BOOT if that variable is set — the same fail-closed
    idiom as the auth gate. Verified that no UI path accepts a SimpleFIN token;
    the access URL is env-only, so the credential HARD RULE is safe by
    construction.
  - Rejected: a "try it" that shows optimistic UI and never persists. That is
    hidden-not-blocked, and it lies to the visitor.
  - The rule most likely to be broken LATER is the analytics one. A demo invites
    "how many people tried it?" — the answer stays no.

## Backlog (agreed, not yet scheduled)

- **Savings goals on /insights — BUILT 2026-07-31.** The design below is what
  shipped, kept because it constrains changes to it.
  The shape is a declared target with a horizon — "House deposit, $155,503.76 by
  Jun 2028" — shown against the observed savings rate: saved so far, rate, the
  date it lands, and how that compares to the target date. It reuses
  `CASH_FLOW_TREND` for the rate and the `computeRunway` arithmetic in
  `ui/liquidity.ts` (a test pins the two windows equal), and it inherits the
  same refusals — too few complete months, or a savings rate at or below zero,
  and it says so rather than printing a fantasy date. Chipped `PROJECTED` like
  every other forecast.
  What was REJECTED, and why, because it is the obvious thing to ask for next:
  PER-CATEGORY MONTHLY BUDGETS. The pace call already answers "am I spending
  more than usual" from the operator's own history and needs no configuration,
  so a budget replaces observed evidence with a typed number — less evidence,
  not more. And twelve categories times every month is a wall of red that
  trains the reader to ignore it, which is the same flooding failure the
  anomaly pass spent real effort escaping. A savings goal is different in kind:
  the app cannot infer a house deposit target, so declaring it adds information
  the data does not contain. That is the test for whether something earns
  configuration.
  Both open decisions settled at build time. (1) "Saved" is a NOMINATED SET OF
  ACCOUNTS, declared per goal: cash as a whole breathes by a rent cycle and
  counts the emergency fund toward the house; net worth drags in market noise
  and the snapshot machinery. Declarations live in the `Setting` key
  `goals.savings` (`npm run goals`, same needle-resolution as `accounts:cash`),
  so a goal is a DATA change run once per database and no schema touched
  either one. The RATE stays the app-wide `CASH_FLOW_TREND` net — transfers
  are excluded from cash flow, so moving money INTO the fund cannot inflate
  the rate that projects it; the projection therefore assumes future net
  savings reach the fund, and when two goals both project, the panel says the
  shared-rate assumption out loud once. (2) A slipping goal does NOT reach
  Overview — Overview carries state and just shed its projections; the panel
  renders on /insights only, gated to the month being lived in like pace and
  commitments, since saved and the rate are measured from now. The analyzer is
  a pure function over plain arrays (`insights/goals.ts`); a reached goal is a
  fact and refuses nothing, and every refusal keeps the facts either side of
  it — saved, target, and the negative rate that IS the reason there is no
  date.
  A declaration HELPER was added 2026-08-01: `--house-price` (with `--down`
  and `--closing`, defaulting 20 and 3) derives the target as CASH NEEDED —
  (down% + closing%) × price — prints the arithmetic, and stores only the
  resulting number (plus, since the third pass, the house PRICE itself as a
  declared aspiration — shown on the readiness band; the percentages are
  still not kept). The derivation is evaluated once at declaration, in front
  of the operator, and never re-runs at render; a bare "30% of the house" was
  rejected as a stored formula because the percentage is market- and
  loan-product-specific, but survives as roughly what down+closing+buffer
  totals, which is why 20+3 are the visible defaults rather than a constant
  buried in code.
  AMENDED 2026-08-01, twice, both operator decisions made against evidence.
  (1) `--accounts=cash` nominates the operator's cash DEFINITION (DEPOSITORY
  plus `accounts:cash` extras), resolved fresh at every render, as a goal's
  fund. This partially reverses the nominated-set decision above, and the
  evidence is the transfer routing: savings observably accumulate ACROSS cash
  (checking absorbed the monthly residual while the nominated fund received
  nothing after its one-time seeding), so a single nominated account
  understated saved by the whole checking balance. The costs the original
  decision named — cash breathes by a rent cycle, the emergency fund counts
  toward the house — were accepted with eyes open, and nominated goals remain
  for anyone who wants the boundary. (2) `--by` is now OPTIONAL: the landing
  date is always PROJECTED from the observed rate, and --by only declares the
  aspiration to compare against; omitted, the panel prints the projection
  alone and invents no ahead/behind. What neither change fixes, said here so
  it is not rediscovered: the RATE is still income-minus-spending, and a
  standing transfer OUT of cash into investments ($3,628.42/mo here) leaves cash
  growing slower than the rate projects (~$4,232.29/mo observed against $7,860.72
  projected), so even a cash goal's landing date reads optimistic while that
  transfer runs. Transfers were excluded from the rate deliberately (so
  funding a goal cannot inflate it); the asymmetry is the accepted cost, and
  a reconciliation line ("cash grew $X over the window vs $Y projected") is
  the honest follow-on if it ever needs fixing. BUILT 2026-08-01, the day the
  operator caught the gap on the live panel — evidence in
  docs/conventions/goals-and-insights.md.

- **House-readiness model — DESIGNED 2026-08-01, BUILT 2026-08-01.** Shipped as
  designed — analyzer insights/readiness.ts, scripts/set-readiness.ts writing
  the readiness.house Setting (npm run readiness), panel below savings goals,
  gated like them; the worked example is pinned by tests within $5.18k of every
  book number and the build/review deltas are recorded in
  docs/conventions/goals-and-insights.md. The rate stays typed by default;
  the FRED fetcher SHIPPED 2026-08-02 — opt-in via FRED_API_KEY, evidence
  in docs/conventions/sync-and-data-ops.md. The design below is kept because it
  constrains changes. Answers "am I
  close enough to start looking?" — a READINESS signal, explicitly NOT lender
  math: whether underwriting would approve is a question the model
  deliberately does not answer, like the tax cost of liquidation below.
  REJECTED first, so they are not re-proposed: gross-income DTI (28/36) —
  bank inflows are net of tax/401k, so observed data is the wrong shape for
  lender rules and the right shape for something better; and
  mortgage-as-share-of-observed-SPENDING — the denominator is the thing the
  operator controls, so it punishes frugality (measured: 35% of July's $11,058.91
  spending is $3,872.04, BELOW the $4,662.52 rent already carried in a month that
  netted +$3,104.89).
  The canonical form is the RESIDUAL:
  PITI budget = observed net income − observed non-housing spending − declared
  savings floor, all over the same 6-complete-month window runway and goals
  use. Non-housing = total spending minus Rent & Housing PER MONTH, then
  averaged — which makes the form REFUND-PROOF: June 2026's Rent & Housing is
  −$401.85 (a reimbursement month), which distorts any "rent + savings rate"
  form and cancels out of this one. That is why the residual form is canonical
  and the rent+rate form is only a derived identity.
  One declared knob: the savings floor — how much monthly saving must survive
  the purchase — operator-set at $5,183.46/mo, stored as a Setting beside the
  goal. Typed assumptions, each rendered with its value and chipped ASSUMED:
  rate and term (typed, shown with its as-of date — the fetcher above is the
  opt-in follow-on; never bake a default rate into code), property tax and
  insurance as %/yr of price, PMI below 20% down, closing as % of price paid
  from cash.
  Outputs are TWO price ceilings with the binding one NAMED: fund-limited
  (the no-PMI path — the fund covers down + closing) and payment-limited (the
  amortization back-out, PMI included below 20% down). Worked at design time:
  PITI budget $6,465.61/mo; the $156k target buys ~$676k conventional with
  ~$2,100/mo of payment slack, ~$880k stretching through PMI; balancing the two
  constraints wants ~$230k cash for ~$999k of house. The fund-limited ceiling
  moves NOT AT ALL with the rate, so a live rate feed refines the non-binding
  side — a polish, not a prerequisite.
  Constraint wording is FUND-LIMITED, never "deposit-limited": the binding
  constraint is the DECLARED FUND, and phrasing it as incapacity is factually
  wrong for an operator holding a taxable brokerage that could fund a deposit
  tomorrow. The model measures readiness OF THE DECLARED PLAN — that scoping
  is what keeps the signal from reading "reached" at declaration for anyone
  with a portfolio. LIQUIDATION-FUNDED deposits are out of scope with the
  reason recorded: SimpleFIN supplies balances and transactions, not lots or
  cost basis, so after-tax proceeds of a share sale are `known:false` and a
  printed number would be fabricated; and whether to de-risk equities for a
  house is a portfolio decision, not arithmetic. Supporting observed fact:
  July 2026 alone moved the portfolio −$18,935.72 on market movement, which is
  why money with a closing date migrates to cash-like instruments. The
  VERIFIED transfer picture (2026-08-01 — the first draft of this entry got
  the destination wrong, caught by recomputing against the database): the
  fund was seeded ONCE, $51,355.89 into TOD (0006) on 2026-01-12, and has
  grown only by money-market dividends since (~$142.55/mo, matching the
  counts-as-cash convention above); every one of the fourteen standing
  $3,628.42/mo transfers lands in the OTHER Individual account (0001), the
  actively-invested one. So the DECLARED FUND currently receives no ongoing
  contributions, and the goal's landing date leans entirely on the panel's
  stated assumption that future net savings reach the fund — an assumption
  today's transfer history contradicts. The transfers are TRANSFER-flagged on
  both sides, so counting them as saving would double-count (the rate already
  contains them as income-not-spent).
  Refusals inherited whole: fewer than 3 complete months; floor at or above
  income minus non-housing (the budget is ≤ 0 and it says so, naming the
  floor as the reason); nothing computed across coverage-incomplete periods.

- **User documentation before anyone else runs this — AUDITED 2026-08-01, NOT
  WRITTEN.** Verdict: a stranger cannot follow everything today. README covers
  setup, the trust model and both data-in paths, but its command table is
  missing `upgrade`, `accounts:cash`, `rules:audit`, `rules:simulate`,
  `import:balances` and `schema:push`, and the `goals` row predates the `cash`
  keyword and optional `--by`. DEPLOY.md is current and battle-tested.
  CLAUDE.md is institutional memory for maintainers and must never be what a
  user is handed. Missing entirely: a first-run walkthrough (clone → seed or
  claim SimpleFIN or import CSV → sync → what each tab answers), a CSV mapping
  guide with real examples, the run-once-per-database lifecycle explained as a
  concept (upgrade / schema:push / goals / accounts:cash — CODE ships with git
  push, DATA does not, and a user who misses this ships half-fixes), and
  troubleshooting for the traps already paid for (the AUTH_PASSWORD_HASH `:`
  delimiter, db:seed wiping insights, the dev-server/.next corruption). Write
  these as USER docs — README plus docs/ — not more of this file.
- **P2P review, still open:** (c) recurring-pattern detection on P2P (same
  payee, same amount, monthly) to pre-fill rule suggestions; (d) an explicit
  "P2P — Unreviewed" bucket so analytics are visibly-incomplete rather than
  silently wrong while the pile shrinks. (Bulk grouping-by-payee and
  reimbursement auto-suggest are both DONE — see Conventions.)
- **Deeper history.** SimpleFIN caps a request at 90 days (it reports this as a
  feed warning, surfaced on the provider health line). History accumulates
  going forward since syncs never delete; CSV import is the backfill path for
  anything older, and dedups on (accountId, externalId).
