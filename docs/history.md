# Ducat — build history

> Figures in this file are not real. Those present at publication are scaled by one unrecorded constant, so their ratios are exact; any added since are invented. See [publishing.md](conventions/publishing.md).

Moved VERBATIM from CLAUDE.md on 2026-08-01 (the split). This file holds the
full evidence — what each rule cost and why alternatives failed. The one-line
enforceable rules live in CLAUDE.md and point here. Additions follow the same
contract: rule line in CLAUDE.md, evidence here, never both in one place.

## Shipping to other people (SHIPPED 2026-07-26)

All four items are built; the details that constrain future changes are in
Conventions above. The pack went from 160 rules to 421 and from 12 categories
to 15, so a fresh clone now starts with the structural rules, the processor
prefixes, the chain list and the account-type inference that previously existed
only in the operator's hand-tuned database.

Two facts worth keeping. First, the pack is now large enough that its own
consistency needs testing, not just its output — `rulePack.test.ts` asserts no
value is listed twice (installRulePack dedupes against a DATABASE, not against
the pack) and that every rule points at a category the pack installs. Second,
this changed almost nothing for the operator: simulating the new pack against
2638 real transactions rewrote 80 rows, all of them `categorySource`
AGGREGATOR → RULE on credit-card payments already flagged TRANSFER by pair
detection. No category moved and no total changed, because ~160 user rules at
priority ≤50 outrank the whole pack — which is the intended relationship. The
value is entirely for the next person to clone it.

What deliberately did NOT ship: rent-portal rules (PayLease and Zego billed the
operator's convenience FEE, not the rent, and arithmetic can't tell which is
which), and anything institution-specific like a brokerage's own ACH
descriptor. Those stay the grouped review's job.

## Build order and status

The order was deliberate and still constrains changes. Contracts came first
(`src/types/contracts.ts`) so nothing downstream could depend on a connector
shape. The insights engine was built and tested against FIXTURE data before any
connector existed — which is why the five analyzers in `src/lib/insights/` are
pure functions over plain arrays, the property that makes browser-side E2E
viable later. Connectors then normalized into contracts the engine already
consumed (`src/lib/connectors/`, `src/lib/sync/`), and provider health plus
subscription tracking (`src/lib/health/`) followed because real syncs could now
fail. The six UI tabs (`src/app/`) came last, over an engine already producing
typed insights. Security hardening came AFTER the surface existed — an audit of
a finished attack surface, not a guess at one — converting "nothing leaves the
machine" from developer discipline into enforced controls (`next.config.ts`,
`src/middleware.ts`). Cloud mode (`src/lib/auth/`, `vercel.json`) amended the
localhost HARD RULE only once local was proven.

Ducat has been exercised on four figures of real transactions across multiple
real accounts and years of history, not just fixtures. Most of Conventions above
exists because real money surfaced what seeded data could not — CSV mappings that
were wrong against actual bank exports, and net worth and anomaly analytics that
were both fabricating results at scale. Two adversarial QA passes then found what
even real data hadn't: a first-run crash, a destructive command with no prompt,
and several silent money errors. The lesson worth carrying: **most of these were
invisible to tests and to normal use — they needed someone deliberately asking
"what would break this?"**

**Session 9 — Cloud deployment (DONE 2026-07-26).** Live at
`https://<your-deployment>.vercel.app`, Turso database `ducat` in `aws-us-east-1`
(paired with Vercel's `iad1`: every route is server-rendered on demand, so each
page view is several function→database round trips). Verified from outside —
every page 307s to /login, the cron 401s without a token and with a wrong one,
CSP/HSTS and four more headers present, and production correctly lacks the
dev-only `'unsafe-eval'`. Login and data rendering confirmed on a phone.

Four things the runbook was wrong or silent about, all now fixed in DEPLOY.md
and worth not relearning: npm's banner ended up inside `baseline.sql` and
killed the very first command; the baseline creates tables but no rows, so the
instance came up with zero categories until step 3 was added; the Turso CLI
ships Darwin/Linux assets only, so Windows needs the dashboard plus
`npm run turso:push` (which refuses a non-empty database); and step 4's
generators print `.env` LINES, so pasting them into Vercel's form buries quotes
inside the secret and login fails with nothing on screen to say why.

The cloud database now holds the full copy: `/api/diag/timing` reports 2638
transactions across 21 accounts and 15 categories, matching local. Its review
pool is empty (0 uncategorized non-transfer rows), so the P2P backlog went over
with everything else.


## Built from the backlog

Moved VERBATIM from docs/backlog.md on 2026-10-04, when that file was cut to
open items only. Entries keep their order and wording, including "above" and
"below" pointers that referred to their old neighbours (most of those meant
CLAUDE.md, before the 2026-08-01 split). Each entry still open stayed in
backlog.md and is marked where it stood.

### Agreed order (2026-09-16)

The operator's data first, then what a visitor to the repository sees.

1. **Overview donut names more categories — BUILT 2026-09-16.** Every
   category at 3% or more, as many as eight legend rows hold, beside the
   balance table. Evidence: docs/conventions/ui-and-pages.md, OVERVIEW NAMES
   EVERY CATEGORY WORTH A SLICE.
2. **P2P review, both halves — BUILT 2026-09-16.** See the P2P entry below for
   what was decided; evidence in docs/conventions/merchants-and-rules.md, P2P
   IS NEVER CATEGORIZED UNSEEN.
3. **Demo data, generated relative to today — BUILT 2026-09-16.** `scripts/seed.ts` pins "today"
   to a fixed date, so a screenshot or a demo built on it shows an empty
   current month on /insights, whose panels are gated to the month being lived
   in. One invented generator serves both the screenshots and the demo, and it
   must exercise every feature a picture or a visitor reaches (P2P rows
   included, once item 2 ships).
   It surfaced two app issues — BOTH FIXED 2026-09-16, before any screenshot: a single large purchase appears twice in
   /insights' digest — once as a one-off, once as its category "trending up …
   $N/yr if it holds", projecting a one-off as if it recurred — and Overview's
   Owed total labels every debt account a "card", loans included.
4. **The GitHub page, recruiter-first and inviting to new users — BUILT
   2026-09-16**, except the demo link, which waits for item 5. Logo chosen:
   the solid gold coin. Evidence in docs/conventions/publishing.md, THE
   README'S PICTURES. A banner or
   logo (none exists — `public/` holds only framework starter icons), a tidier
   README layout, a short walkthrough recording near the top, and desktop
   screenshots of Overview, Trends, Insights and Transactions in SEPIA, all from
   the invented data. Screenshots must not fall out of step with the UI: one
   command recaptures them, and a CI check fails a PR that touches a pictured
   page without updating them unless its description carries
   `screenshots: unchanged — <reason>`. The recording is retaken on substantial
   change only, and is outside that check.
5. **The public demo instance** (design below), linked as a button at the top
   of the README. It deploys from `main`, so its screens cannot lag the code;
   only the generator has to keep up. LIVE 2026-09-18 and linked from the
   README. A README cannot embed it — GitHub strips
   iframes and scripts, and the app refuses framing — which is why the
   recording exists.

### Backlog (agreed 2026-07-27, investigated, not yet built)

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
- *(The shattered-merchant-strings entry is still open: see [backlog.md](backlog.md).)*
- ~~Another pass on subscription detection~~ — AUDITED, and the answer is
  DON'T. See the recurring-detection convention above.
- **A public demo instance** — DESIGN AGREED 2026-07-27, CODE BUILT 2026-09-18
  (demo mode: DUCAT_DEMO_PASSWORD; see docs/conventions/security-and-auth.md,
  THE PUBLIC DEMO); the deployment itself is the operator's to create.
  Originally DEFERRED on purpose.
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

### Backlog (agreed, not yet scheduled)

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

- **User documentation before anyone else runs this — AUDITED 2026-08-01,
  WRITTEN 2026-08-01 (the user-docs commit).** Shipped: docs/getting-started.md,
  docs/csv-import.md, docs/lifecycle.md, docs/troubleshooting.md, and
  README's command table brought up to reality. The audit below is kept
  because it is the specification those docs answer.
  ONE RESIDUAL, and it is the entry's own lesson repeating: the command
  table DRIFTS — it was repaired here and wrong again within four days.
  REPAIRED AND GUARDED 2026-08-06; the story is in
  docs/conventions/sync-and-data-ops.md and the guard is
  scripts/commandTable.test.ts. Kept as one line rather than three copies of
  the same paragraph, which is what this file had.
  The original audit verdict: a stranger cannot follow everything today. README covers
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
  DECIDED 2026-09-16, BOTH, scheduled after the Overview donut — BUILT the
  same day. Two further decisions came with the build: rows the old rules had
  already categorized stay as they are, and a user rule that marks a P2P
  payee a TRANSFER still applies on its own.
  - Every UNCONFIRMED P2P payment sits in "P2P — Unreviewed", including the
    ones carrying a suggestion. Outflows count toward spending as that slice
    of their own; inflows stay out of spending and are flagged on
    Transactions only, since counting them would shrink the spending total.
  - A suggestion is PRE-FILLED and needs a confirmation, never applied
    silently — including for a payee that already has a user rule, because
    one person can be paid for different things. The point is that nothing
    is missed.
  - Measured before scheduling: the operator's own P2P backlog was already
    worked down to almost nothing, so the feature's value is chiefly for a
    new instance's first sync and for the demo — which is why it waits
    behind the donut rather than leading.
- *(Deeper history is still open: see [backlog.md](backlog.md).)*
- **A LOOK-AT-EVERYTHING UI pass across all six tabs — raised 2026-08-03, RUN
  AND SHIPPED 2026-08-03.** Six agents ran as designed and their findings
  landed in seven commits: the correctness pass (six correctness fixes), then waves 1-5 —
  wave 1 (eight surfaces that stated something untrue), wave 2 (the phone
  pass the 44px commit started), wave 3 (space spent on what each block has
  to say), wave 4 (the trust page states what cloud mode costs), wave 5
  (polish) — plus two more that day for the nav scroll origin and the
  picker anchor. The rules they produced are in CLAUDE.md and
  docs/conventions/ui-and-pages.md; that is where the outcome lives.
  THE STARTING COMPLAINT IS FIXED, both halves: /trends' three blocks now
  stack FULL WIDTH (`lg:grid-cols-2` is gone, its removal recorded as a
  rule), and the category column carries the prior period's DOLLARS instead
  of the five-units-per-column ratio — so the multiplier form that "nobody
  has defended since it was written" no longer exists. The `new` / em-dash /
  null-base refusals were kept, as required.
  The design below is kept because it is the shape any FUTURE pass should
  take, and because the paragraph after it records what was measured.
  Every surface has been built or amended by a different session
  against a different question, and nobody has since sat down and simply
  LOOKED at all six as a set: Overview, Trends, Insights, Transactions,
  Accounts, Providers. The shape agreed for it: SIX PARALLEL AGENTS, one per
  tab, each driving the REAL page on real data (production build, and the
  deployment for anything that is a timing claim), reporting what reads
  wrong, what is cramped, what is unreachable on a phone, and what could be
  enhanced — findings ONLY, no edits, so the operator picks what ships.
  Each agent judges against docs/conventions/ui-and-pages.md and the
  "verified load-bearing" list, because half of what looks like clutter on
  this app is a refusal that was paid for: the coverage notices, the
  `known:false` gaps, the reimbursements-exceeded state, "all clear" being
  stated rather than implied, the estimated-balance qualifiers. A finding
  that proposes deleting one of those has to argue with its evidence file,
  not with taste. Worth pairing with a phone-width pass (the 44px tap-target
  work is the precedent) since every tab is read on a phone more than a
  desktop.
  ONE CONCRETE COMPLAINT ALREADY ON THE TABLE, and the audit that settled
  what did and did not change: /trends' SPENDING BY CATEGORY table is
  SQUISHED — it lives in a narrow grid column beside the donut and carries
  four columns (category, spent, vs prev, share), two of which are ratios
  (`vs prev` as a percentage that flips to a MULTIPLIER `×N.N` above
  +999%, `share` as a rounded percentage). The operator remembered this
  being fixed; it was NOT. `git log -S` puts the `×${(1 + deltaPct)}`
  branch in the ORIGINAL trends commit (2026-07-12, session 5) and unchanged
  since. What DID land on /trends afterwards was different work — chart
  legibility without a mouse (2026-07-26), 44px tap targets (2026-07-26), one
  spending total and one share denominator (2026-07-26), no percentage against
  a base ≤ 0 (2026-07-26, now the pctDelta rule), the coverage notice
  correction (2026-07-31), and room for the net-worth line (2026-07-31). So the
  table's width and its two ratio columns are the ORIGINAL design, never
  revisited, and the multiplier form in particular is a rendering nobody
  has defended since it was written. Start the pass there.
  MEASURED ON THE DEPLOYMENT 2026-08-03, so it is not re-derived. Desktop at
  a 1652px viewport: the table is 280px wide inside a 534px SECTION — it uses
  barely half of its own column, and that column is a third of the screen, so
  the squish is self-inflicted by the grid rather than a shortage of room.
  Mobile at 375px: a 327px table with NO horizontal scroll (that part is
  fine), but `vs prev` gets 70px and the category column 133px, so precision
  is bought entirely out of the category names. The real July rows show the
  defect is UNITS more than width — one column carrying five different
  forms: a percentage (`+58.25%` Dining), a MULTIPLIER (`×11.4`
  Entertainment), the word `new` (Groceries, no prior row), an em dash
  (Rent & Housing, prior base not positive), and `+0.00%` for an unchanged
  Utilities. A reader scanning that column switches units per row.
  Before "fixing" it: `new`, the em dash and the null-base refusal are
  LOAD-BEARING (money-and-analytics.md — pctDelta is null for any base ≤ 0).
  The questions actually open are whether the MULTIPLIER earns its place
  beside percentages, whether the column should carry a ratio at all rather
  than the prior period's dollars, and why the table is half the width of
  the space it already owns.

- **A DATABASE-UNREACHABLE state that says so — raised 2026-08-04 during a real
  outage, BUILT 2026-08-06.** Shipped as designed: `src/lib/ui/dbHealth.ts`
  classifies the caught error, `withDatabaseNotice` wraps all six pages'
  renders, and `DatabaseUnavailable` names the condition without naming a
  culprit and without ever implying the data is gone. The evidence lives in
  docs/conventions/ui-and-pages.md — the copy doctrine, why the generic
  boundary structurally cannot do this job, and the assert-on-PRESENT rule —
  and that is where the outcome lives.
  THE SIGNAL RECORDED HERE WAS PARTLY WRONG, which is why this is now a pointer
  rather than a second copy. Measuring eleven scenarios on 2026-08-06
  contradicted three claims made from a single Vercel log line: `P2010`
  belongs to the `$queryRaw` path only (a model query throws a bare
  `DriverAdapterError` with NO `code`, and `P2010` fires just as happily for
  a SQL typo against a healthy database); `P1001`/`P1017` cannot fire through
  this adapter at all, so a branch for them would be dead code; and the 6-10
  second signature is undici's connect timeout for a BLACKHOLED host, not a
  general tell — an answering-but-failing edge takes ~2.2 s and a DNS failure
  ~90 ms. Biggest of all: a missing `data/ducat.db` does NOT fail, because
  libSQL creates the file, so local mode's real symptom is a missing TABLE and
  needed a fourth state with its own advice. Read the convention file, not this
  paragraph, before touching the classifier.

- **`npm run upgrade` skipped insight regeneration whenever the rule pack was
  already current — found 2026-08-06 auditing README's table, FIXED
  2026-08-08.** Call-site sequencing only: the early return is gone, the pack
  install and its result logs are wrapped in `if (pending > 0)`, and
  `generateInsights` runs unconditionally below them; neither
  `sync/rulePack.ts` nor `insights/engine.ts` was touched. The four decisions
  it forced (`--check` gains a line, "Nothing to do." is deleted rather than
  reworded, MONTH stays hardcoded with no `--granularity`, and no pure function
  was extracted — with the reason that one cannot fail on this bug), what it
  makes true of the two-database rule, and the one dismissal that cannot
  survive it are all in docs/conventions/sync-and-data-ops.md. README,
  DEPLOY.md and docs/lifecycle.md were corrected in the same commit: all three
  described the skip as intended behaviour, and none of them is guarded by a
  test. The original entry follows, because it is the evidence.
  scripts/upgrade.ts returns at "Nothing to do." the moment `pendingPackRules`
  is 0, and the `generateInsights` call sits below that return — so the one
  command the docs point at for "after `git pull`, bring this database up to
  the checked-out code" does nothing at all after a release that changed
  analyzer math and shipped no new pack rules, which is the common case in this
  repo. The comment directly above that call states the opposite intent
  ("Doing it unconditionally here costs one pass and removes the case where new
  rules changed nothing today but the stored insights predate them anyway"), so
  the early return defeats a decision already made deliberately.
  README's row now describes the ACTUAL behaviour and points at
  `npm run insights:generate` for that case, so nothing is currently
  misleading. The fix itself is small — make the pack install conditional
  rather than the whole run — but it changes what a row-writing command does to
  both databases, so it is a decision rather than a cleanup, and it belongs to
  whoever next touches the upgrade path.

- **`app/error.tsx` was half dead in production — found 2026-08-06 proving the
  entry above, FIXED 2026-08-06.** Its `expired` branch tested
  `/not authenticated/i` against `error.message`, and Next 15 replaces a server
  error's message with a digest before the boundary ever sees it — so the
  "Session expired" state could never appear on the deployment, the one place
  the failure it exists for actually happens.
  INVESTIGATING IT FOUND A SECOND, LARGER REASON, and that is what changed the
  fix: the branch is unreachable regardless. A Server Action POSTs to its page
  path, middleware matches it, and a request carrying no valid session is
  answered 401 at the transport — measured by sending exactly that request — so
  `requireSession()` never runs. Repairing the regex alone would therefore have
  changed nothing a reader sees.
  So both halves shipped: the throw now carries a stable DIGEST (the one field
  that survives a production build) for the paths where it can fire, and the
  generic copy was rewritten, because it had promised “Your data is unchanged;
  retrying is safe” and both halves were wrong — an action can throw after a
  partial write, and retrying a lapsed session fails identically. Evidence in
  docs/conventions/security-and-auth.md.

- **SCHEDULED LOCAL BACKUPS — raised 2026-08-04 after a two-hour Turso outage,
  BUILT 2026-08-04, the same day.** Shipped as the shape below agreed, plus
  the answers to what it left open, all recorded with evidence in
  docs/conventions/sync-and-data-ops.md: the `backup.lastRun` Setting lives
  in the CLOUD (the phone is the primary read; the wrapper writes it cloud
  first, then byte-identically to local — the mirror step for that one row),
  and it means FINGERPRINT-VERIFIED, written only after the whole-database
  digests of the new file and the cloud match. What the build taught, so it
  is not relearned: the canonical `ducat-….db` filename is EARNED — a failed
  run's leftover under that name would eventually be elected a month's sole
  retention keeper while proven backups were deleted around it (adversarial
  review caught it; copies land on `.partial`, failures quarantine as
  `.unverified`); the WARN threshold shipped one night looser than every
  document promised until the same review recounted it (floor-of-elapsed
  already IS the missed-night count); Windows holds a just-closed libSQL
  file handle for ~8 seconds after a whole-database read, so backup renames
  retry (`renameWhenReleased`); and registering an S4U task requires an
  elevated shell. Registered, fired headless (LastTaskResult 0, next fire
  23:50 UTC), signal live on the cloud /providers, and cloud/local proved
  digest-equal (`657c0c69e641281a` both sides) the same night. The original
  entry stays below because it is the design's evidence.
  Turso's us-east-1 router returned 502 to every query for
  over an hour. Nothing was lost, but the operator had no local copy at the
  time and `cloud:backup` cannot run when the database is unreachable — the
  one moment you want a backup is the one moment you cannot take one. Free-plan
  point-in-time recovery reaches back 24 hours, and it lives in the same
  failure domain as the outage.
  Shape agreed, in four parts. (1) A wrapper the Windows Task Scheduler can
  fire, sourcing the two Turso variables from somewhere gitignored or from
  Windows Credential Manager — never inline. (2) Timing is load-bearing:
  **23:50 UTC**, AFTER the `0 23 * * *` cron plus Hobby's documented 8-43
  minutes of lateness. Backing up before the sync permanently captures
  yesterday, which is exactly the mistake made by hand on the day this was
  raised. (3) A `Setting` row recording the last backup instant, so
  `/providers` can render "last local backup: N days ago" and escalate it the
  way balance and rate staleness already do — a backup job that dies quietly
  is worse than none, because you believe you are covered, and this app's own
  doctrine is that all-clear must be STATED. (4) Retention: `cloud:backup`
  never overwrites, so prune to ~14 dailies plus one a month beyond.
  Verification already exists (`npm run db:fingerprint`, 2026-08-04) and the
  scheduled job should use it rather than trusting row counts.
  REJECTED, with the reason recorded so it is not re-proposed: a scheduled
  GitHub Action or any cloud CI pulling the backup. It is the obvious
  suggestion and it puts transaction data in a third party that is not the
  operator's own single-tenant infrastructure — the data-locality HARD RULE.
  The backup has to land on hardware the operator controls.

- *(A net-worth goal is still open: see [backlog.md](backlog.md).)*

- **HOUSEKEEPING, all three verified 2026-08-05, ALL THREE DONE 2026-08-06.**
  Small, safe, and written down only because each is invisible until someone
  goes looking. What shipped, in order:
  (1) The command table is repaired and, more to the point, GUARDED —
  `scripts/commandTable.test.ts` now fails `npm test` when a script has no
  row. The audit found the list below UNDERCOUNTED: seven commands were
  missing, not six (`simplefin:claim` was overlooked because it appears in
  README prose, and prose is not the index), and six rows already in the table
  had drifted besides. Evidence in docs/conventions/sync-and-data-ops.md.
  (2) Both stray branches deleted with `git branch -d` — re-verified at 0
  commits ahead of main first, and the safe variant took them without
  complaint. (3) The empty worktree directory removed; the shell holding it
  open had exited, and it was confirmed empty (zero entries, recursive) before
  the `rmdir`.
  The original entry stays below because it is the evidence for why the first
  item needed a test rather than another repair.
  (1) **README's command table has drifted again** — the exact failure the
  user-documentation entry above was raised for, repeating one audit later.
  Missing today: `auth:set-password`, `auth:set-totp`, `backup:scheduled`,
  `db:fingerprint`, `db:reset`, `readiness`. Four of the six were added in
  the two days after the docs were written, which is the point: the table
  does not drift by neglect, it drifts by SHIPPING. `postinstall`, `lint`
  and `turso:baseline` are internal and correctly unlisted, so the fix is
  six rows, not nine. The durable form of the fix is the rule — a commit
  adding a `package.json` script owes the table a row in the SAME commit —
  because a table repaired by hand every few weeks is a table that is wrong
  most of the time.

### Left open by the 2026-08-06 session

Each verified the day it was written, so nobody re-derives it. None is a
blocker; all are the kind of thing that is invisible until someone looks.

- *(The unseen cloud-mode database-unreachable page is still open: see [backlog.md](backlog.md).)*

- **`requireSession()` throws where it could redirect — DECIDED 2026-08-06:
  KEEP THE THROW. Not a defect.** Recorded so it is not reopened.
  Changing it would edit code that provably cannot execute: an unauthenticated
  Server Action POST is answered 401 at the transport before any action code
  runs (measured, in production), and GETs are redirected to /login — so no
  request reaches this function without a session. A redirect would therefore
  change nothing a reader ever sees.
  It would also be WRONG for one of its callers. `requireSession` guards
  `/api/diag/timing` as well as the Server Actions, and `redirect()` in a route
  handler answers a JSON endpoint with a 307 to an HTML page — worse than the
  throw for anything reading it programmatically. One function, two calling
  conventions, and only the throw suits both.
  What made the throw look broken was never the throw: it was the BOUNDARY
  reading a message production does not send, and the copy it showed. Both are
  fixed (docs/conventions/security-and-auth.md). The throw stays as defence in
  depth, which is what Next's own guidance asks for and what a future change to
  the middleware matcher would need.

- **`/api/diag/timing` failed illegibly during the exact outage it is for —
  FIXED 2026-08-06.** It ran every probe with no error handling, so an
  unreachable database gave an unhandled rejection and a 500, on the endpoint
  that was one of the three steps the 2026-08-04 diagnosis actually took. It
  now catches, classifies with the SAME `databaseFailure` the pages use — so
  the two cannot disagree about what is wrong — and answers 503 naming the
  condition. A non-database error still 500s, deliberately.
  THE `SELECT 1` BLINDNESS IS NOT FIXED AND SHOULD NOT BE: `connectMs` times a
  bare `SELECT 1` precisely because it touches no table, which is what makes it
  a clean measure of connection setup (performance.md depends on that). The
  consequence is that it succeeds against a reachable database with no schema
  at all. Rather than break the measurement, the endpoint now reports what the
  real queries found: pointed at an empty database it answers
  `failure: "no-tables", reported: "Transaction"` where it used to 500. The
  header comment states that a healthy `connectMs` is evidence of a reachable
  server and nothing more.

- **Two script-hygiene gaps, verified 2026-08-06, BOTH FIXED 2026-08-06.**
  `install-rule-pack` calls `printDatabase()` before it writes anything, and
  `audit-subscriptions` now loads `dotenv/config` and names its database too —
  README's rows carry the marker for both, since the marker is a contract about
  what a command prints. Proven by pointing `DOTENV_CONFIG_PATH` at an env file
  holding a DIFFERENT path and watching both commands report it: the local
  `.env` sets `DATABASE_URL` to exactly the built-in fallback
  (`file:./data/ducat.db`), which is why the dotenv gap was invisible and why a
  same-value run proves nothing. The original entry follows.
  (1)
  `scripts/install-rule-pack.ts` writes rows — it installs pack rules,
  retroactively recategorizes transactions and regenerates insights — and does
  NOT print a database label, where 15 other scripts do. It is the one
  row-writer that never says which database it is about to change, against a
  rule the README states as a contract. (2) `scripts/audit-subscriptions.ts`
  imports `prisma` without `import 'dotenv/config'`, unlike 20 siblings, so
  `npm run subs:audit` never reads `.env` — `DATABASE_URL` is unset and
  `src/lib/prisma.ts` falls back to its built-in `file:./data/ducat.db`. It
  therefore audits the default path rather than the configured database, and
  says nothing about doing so. Read-only, so nothing can be damaged; it can
  simply be answering about the wrong file.

- **`/accounts` had no last-sync line of its own — FIXED 2026-08-06.** Its
  per-account "Nd behind" counts from the last successful sync, matching
  Overview, but the page never printed WHEN that sync was — so the figure was
  measured against an instant the reader could not see, which is the whole
  reason it was harder to read here than on Overview. `getAccountsData` already
  queried that row for the arithmetic; it just never reached the page. It now
  returns `lastSyncAt` and the page leads with it, through `dateTime()` like
  every other instant, and says so explicitly when no sync has ever succeeded.
  The row chip's `title=` STAYS, and the first draft of this entry wrongly said
  it had been retired. That tooltip carries both clocks and asserts no cause,
  which was a deliberate 2026-08-03 correction; removing it would undo one
  recorded decision while claiming to honour another. What actually changed is
  that it is no longer the ONLY place the second clock lives — which is the
  part the no-hover rule cares about, because the phone reader was the one
  going without.

- **LOCAL RUNS ONE NIGHTLY SYNC BEHIND CLOUD, PERMANENTLY — diagnosed
  2026-08-06, DECIDED: leave it.**
  SUPERSEDED 2026-09-16: local is now mirrored nightly — see
  docs/conventions/sync-and-data-ops.md, LOCAL IS MIRRORED NIGHTLY. Kept for
  the reasoning below, which that design answers rather than overrides. Recorded because the local app looks
  broken when it is not, and because the next session would otherwise read
  local figures as current.
  The nightly `backup:scheduled` job ARCHIVES; it does not RESTORE. It pulls
  the cloud database into `data/backups/ducat-YYYY-MM-DD-HHMM.db` and never
  writes `data/ducat.db`, which is the database the local app reads. The only
  thing it puts there is the single `backup.lastRun` Setting row — which is
  why `data/ducat.db` carries a file timestamp from the backup run while its
  CONTENTS are days older. That timestamp is the trap: the file looks fresh
  and is not.
  Measured the day this was written: local `fe4b39aeb52cb301`, 2,745
  transactions, net worth $685,279.28; cloud `a07ab18481f93f93`, 1,064
  transactions, $690,917.43 — exactly one nightly sync of drift, and it
  reappears every night, because the Vercel cron syncs SimpleFIN into the
  CLOUD only and nothing pulls those rows back down.
  This does NOT contradict the LOCAL MIRRORS CLOUD rule, and the distinction
  is worth keeping straight: that rule governs DELIBERATE data changes —
  rules, settings, goals — which land on cloud, are confirmed, then copied
  down and proved equal by digest. It never governed the nightly feed.
  NO RESTORE COMMAND EXISTS and one was declined on purpose. `cloud:backup`
  pulls cloud into a dated file and `turso:copy` pushes local into a fresh
  cloud database; nothing goes backup → `data/ducat.db`. A `db:restore` was
  proposed and rejected: the backup's value is being a VERIFIED ARCHIVE, and
  a command that overwrites the working database would discard anything
  local-only without being able to tell that it had. Copy the file by hand on
  the rare occasion local needs to be current. If that is ever revisited, the
  bar is: canonical filenames only (never a `.unverified`), refuse without
  explicit confirmation, and print both digests before and after so the
  operator sees what is being replaced with what.
  PRACTICAL CONSEQUENCE, for whoever verifies next: localhost is the right
  place to check STRUCTURE and behaviour, and the wrong place to read
  FIGURES. Anything about balances, counts or totals is checked on the
  deployment.

### Built since the 2026-10-04 cut

- **Action feedback on the ledger.** A refused action (an empty merchant, a
  rule value too short, a category name that cannot be made) throws to the
  error boundary, and production replaces the message with Next's
  placeholder: `src/app/transactions/actions.ts`, while GroupedReview and
  CategoryPicker print `e.message`. `syncNow` (`src/app/actions.ts`) already
  returns `{ ok, message }`; the refusals should too, shown beside the
  control. Error states are not pictured, so no screenshot retake.
  BUILT 2026-10-04: refusals are returned as values (lib/actionResult.ts) and
  shown beside the control that asked. Evidence in
  docs/conventions/security-and-auth.md, REFUSALS ARE VALUES.

## CLAUDE.md, split twice

The "This file's contract" section of CLAUDE.md as it stood until 2026-10-04,
moved here VERBATIM when CLAUDE.md was split a second time (585 lines to under
200), this time into path-scoped rules files (`.claude/rules/`) and procedure
skills (`.claude/skills/`). The same thing had happened as the first time: rule
lines had collected their stories. The new contract is CLAUDE.md's "Where
instructions live", and scripts/instructions.test.ts now holds the size limit.

Everything here auto-loads into every session, so this file holds RULES ONLY:
each convention is one enforceable line plus a pointer to its evidence file
under docs/conventions/. The evidence — what each rule cost, what was tried
and failed — lives in the pointed file and is REQUIRED READING before changing
anything a rule covers; several record "tried and failed, don't retry". When
adding a convention: rule line here, story there, never both in one place.
The split happened 2026-08-01 at 1,308 lines (~33k tokens per session); every
original word survives verbatim in docs/. Backlog: docs/backlog.md. History:
docs/history.md. User guides: docs/getting-started.md and siblings.

## Product direction (agreed 2026-07-13)

Moved VERBATIM from CLAUDE.md on 2026-10-04; CLAUDE.md keeps the rule.

Distributed software, NOT a hosted service (the Actual Budget model):
each user deploys their own instance (their machine or their cloud) and
brings their own SimpleFIN token (~$15/yr paid by the user to SimpleFIN),
so the maintainer custodies no one's data and aggregator costs stay $0.
CSV import is the zero-dependency fallback. Do NOT build an in-house
aggregator — bank connectivity (not the protocol) is the hard 95% and
there is no free path. "We can't read your data even if breached" (E2E)
is the product's trust story when multi-user matters.
