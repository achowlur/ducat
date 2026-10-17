# Ducat — goals, subscriptions & insights conventions

> Figures in this file are not real. Those present at publication are scaled by one unrecorded constant, so their ratios are exact; any added since are invented. See [publishing.md](publishing.md).

Moved VERBATIM from CLAUDE.md on 2026-08-01 (the split). This file holds the
full evidence — what each rule cost and why alternatives failed. The one-line
enforceable rules live in CLAUDE.md and point here. Additions follow the same
contract: rule line in CLAUDE.md, evidence here, never both in one place.

- `Date.UTC` NORMALISES an impossible day rather than clamping, so a
  subscription billed on the 31st stepped Jan 31 → "Feb 31" → Mar 3, skipping
  February and drifting further every cycle. Clamp to the month's last day, and
  step from the ORIGIN each time — iterating on the clamped result walks the
  billing day backwards (Feb 28 → Mar 28 when the biller charges the 31st).
- Subscription charge matching is a SUBSTRING, so a $647.93 monitor became "Amazon
  Prime charged $647.93 vs $38.85 expected (+1567%)". Prefer charges near the
  expected amount, falling back to the newest so a real price change still
  surfaces. Detected subscriptions also lapse: the recurring detector has no
  recency bound, so a service cancelled years ago billed forever in the
  annualised total until charges older than two cadence cycles were dropped.
- NET WORTH GOAL (2026-10-16). Raised 2026-08-04 and held for discussion,
  because the design question was the whole feature: net worth grows for two
  reasons, saving (a decision, observed) and markets (not controlled, and only
  guessable forward). A single growth rate learned from the past blends the
  two, and in a strong stretch it projects that stretch forever, reading as a
  promise. So the goal prints TWO dates and refuses to blend them. By saving
  alone uses the "saved" half of the /trends split (growthBetween: change
  minus the months' own marketGains), so the pace is a figure the reader can
  find on another screen, not a second definition. With markets adds a yearly
  return the OPERATOR TYPES, after inflation: long-run US stock history is
  about 7% a year real, while the large firms' 10-15 year forecasts sit lower
  (roughly 6-7% nominal, so about 4% real), and the gap between those is
  exactly why the number is the operator's, carried behind the ASSUMED chip
  with the day it was typed, as the readiness rate is. Absent, there is no
  markets date and no default in code.
  Everything is in today's dollars: the target is buying power, the pace is
  held level in real terms, cash is assumed to keep pace with inflation, and
  of what is saved only a typical month's deposit into invested money
  compounds (below); the rest is counted as cash. The return applies to INVESTED
  money only, the investment accounts outside the operator's cash definition,
  so an account the operator counts as cash is never credited with a stock
  return. That split needs each account's month-end value, which the account
  type cannot give, so NET_WORTH_GROWTH rows now carry `byAccount`; a row
  stored before it prints no markets date until regeneration fills it in.
  The monthly deposit was added the same day, at the operator's ask: the
  first cut counted every new dollar as cash, ignoring a steady monthly
  deposit the history plainly shows, and lump sums must not pass for it. It
  is the MIDDLE of the last three complete months of money crossing into
  invested accounts (per account, so the cash definition draws the line;
  rows carry `investmentFlowsByAccount`). Not a mean: a history mixing a
  steady deposit with savings moved in from another bank, a yearly IRA
  contribution and a reshuffle between accounts worth many months of saving
  averages to a habit nobody has. Not a fixed cutoff, the first suggestion
  ("leave out anything over $5,000"): it throws away every month for a
  reader whose ordinary deposit is above it. And not the median of the
  twelve-month pace window, the second cut: the operator asked what happens
  when the deposit goes UP, and the answer was that the median would keep
  the old amount for about six months, saying nothing. Three months is the
  least that still has a middle: one month (a lump sum, a missed deposit, a
  first month at a new amount) never sets it, and two do, so a raise counts
  the moment it repeats. A deposit never changes silently: the anchor
  month's own deposit is named when it does not match ("a new amount counts
  once it repeats"), and a changed deposit says what it was a month before.
  On the history that prompted it the deposit landed exactly on the standing
  transfer.
  The target and the return became CONTROLS on the panel the same day, at
  the operator's ask, instead of numbers set from the command line: a
  slider for the return and a field for the target. The slider runs 0 to
  100% (the operator asked for the full range, for fun) on a SQUARE scale, so
  a quarter of its travel covers 0 to about 7% and 5% does not sit a few
  pixels from the edge of a phone; it snaps to half points below 20% and
  whole points above, with tick marks at the decade's forecasts, at a
  century of history and at 10% (added at the operator's ask). The
  dates re-project in the browser as they move, through projectGoal, the
  very function the server ran, from a serializable GoalBasis per month-end,
  so a slider never waits on a round trip and never disagrees with a reload.
  Each saves when it settles (the slider on release, the target on Enter or
  leaving the field) through one validation, nextNetWorthGoal: a CHANGED
  return is dated that day and an unchanged one keeps its day, so the as-of
  date stays the day the assumption was made. Zero clears the return, and an
  unset return puts the slider at zero, "no market growth assumed", which is
  not a rate, so still no return lives in code. A shift compares the same
  target and return a month apart, so dragging a control never reads as the
  data moving. The command still writes the same Setting.
  The AMOUNT INVESTED A MONTH became a third control (2026-10-16), at the
  operator's ask, defaulting to the measured deposit, so the panel answers
  "what if I invested more?". What a typed amount means had to be chosen.
  Read as a re-split of the same saving, investing more would only move
  money from cash into the market, and an amount above the whole pace would
  draw cash down every month: not what anyone typing a bigger number means.
  So the cash part of the pace holds as measured and the typed amount is
  added to it (withDeposit): investing $500 more a month is saving $500 more,
  and both dates move, the saving-alone one too. The pace and deposit the
  working-out prints stay the measured ones, with the amount set and the
  total beside them. Untouched, the amount follows the data as before; typed,
  it holds (stored as monthlyInvest in the Setting, kept by the goals
  command) behind the ASSUMED chip with a button back to the measured amount,
  and typing the measured amount clears it too. The month that did not match
  is not named while an amount is set: the panel is not using the measured
  one. On the demo, $2,500 a month in place of the measured $1,235 brought
  saving alone from 2052 to 2043 and the markets date from 2041 to 2037.
  INFLATION, SAID OUT LOUD (2026-10-17). Reading the working-out, the
  operator objected that $2,342 saved today is not $2,342 ten years from
  now. The dates are in today's dollars, so they never add nominal dollars to
  a real target; but that frame quietly ASSUMES the saving rises with
  inflation, a deposit held level in buying power being one that grows in
  actual dollars every year. Measured on the demo at 2.5%: cash losing its
  value moved the dates from 2052 / 2041 to 2059 / 2042, and a saving kept
  at the same dollar amount as well gave no saving-alone date inside fifty
  years and 2044 with markets. Dropping inflation altogether was asked about
  and refused: a nominal $1M with a nominal return of about 8% lands years
  sooner on a target that then buys what about $650k does today. So the
  frame stays, and what it asks is printed instead: at an ASSUMED 3% a year
  (ASSUMED_INFLATION_PCT, near the long-run US average; the dates do not use
  it), what the pace means in ten years and the target in the dollars of
  the date on screen, in whole dollars, since cents on a figure grown by an
  assumed rate claim a precision it lacks. And the operator asked to be TOLD
  when to raise the investing: the deposit is compared with the same
  deposit a year earlier (contributionYearAgo, the middle of the three
  months a year before the anchor), and anything under 3% growth reads in
  the warning ink with the amount that keeps up (keepingUp); at or above it
  says so plainly. The SAVING PACE became a field at the same time, beside
  the investing: typed, it is the whole of what is saved and the investing
  is its part; untouched, it follows the data, moved by a typed investing
  amount as before.
  CASH EARNS WHAT IT IS PAID (2026-10-17, the same day). Holding cash level
  in today's dollars was generous for a checking account that pays nothing,
  and the operator pointed out that the accounts are known. The account TYPE
  cannot tell checking from savings (both are DEPOSITORY) but the rows can:
  a checking account that pays nothing has no interest rows, a savings
  account or money market has one every month. An account's change in value
  beyond its deposits cannot be the measure: an account counted as cash
  today may once have held stock funds, whose gains pass for interest (the
  first cut read such an account as paying well above any money market),
  and a lump moved in mid-month reads as earnings. So a yield is read only
  from what an account was PAID: NET_WORTH_GROWTH rows now carry
  interestByAccount (interest and dividend rows by wording, a reinvestment
  and a card's interest CHARGE excluded, magnitude only since sources sign
  them oppositely), and an account's yield is the middle of its last three
  months against the balance it started each month with, so a lump moved in
  mid-month cannot set it. The operator also noted that money reaches a
  high-yield account in bulk, not monthly: the accounts are weighted by their
  AVERAGE month-end balance over the pace window, where the cash sat, never
  today's, which one lump would swing; new cash saving is assumed to land in
  the same mix. Less the assumed 3%, the mix is a real yield applied to
  positive cash only (cards and loans stand still), in both dates: "saving
  alone" means no market return, not cash frozen while prices rise. A row
  stored before the field holds cash level, as before, until the next sync
  regenerates it (every sync regenerates every period). The demo's savings
  interest was a fixed $24-31 a month and read as a high-yield account
  paying 0.6%; it now pays a rate on its balance (under 1% until four years
  ago, 4.2% since), and the demo reads checking at nothing, savings at 4.2%,
  cash losing about 0.6% a year.
  IDLE CASH (2026-10-17, the same day). The operator asked for the money
  market's counterpart of the keeping-up check. It is not the same check:
  money reaches a high-yield account in lumps, so there is no monthly habit
  to grow, and once there it about keeps its value. What loses value is
  money WAITING where nothing is paid. So the panel says when the cash
  accounts that pay nothing hold more than a month of spending, and what the
  best-paying cash account would earn on the rest, priced in months on the
  nearer date (withCashMoved: that share of cash earning the better rate from
  now on). The buffer was first to be what LEAVES checking in a month, and
  the rows refused it: card payments and a lump moved to savings both leave
  as unpaired transfers, so a month holding a lump read as five months of
  needs. A month of SPENDING (the cash-flow analyzer's, cards included,
  transfers out) is what checking has to cover; the middle of the last three
  complete months, so one heavy month cannot set it. Live balances, since it
  asks for an action today; quiet under IDLE_CASH_MIN (,000), after a move,
  and when no cash account pays anything.
  Dates are projected from the last COMPLETE month-end, not the live
  balance: a live anchor would move the date with every day's markets, and
  the shift since last month would compare a month-end with a Tuesday.
  Progress stays live, Overview's headline. The pace window is twelve
  complete months (a bonus or a big bill moves six too far; SIX since
  2026-10-17, once one-off pay was left out, below) and never crosses
  a change in which accounts are counted, since an account entering the sum
  is not saving; under six months there is no date.
  A FAR target is sensitive to pace: saving a tenth faster brings a
  twenty-year landing about two years nearer, and one month entering a
  twelve-month window can do that. That is honest, and a goal that moves
  its own date silently is worse than one that refuses, so each date says how
  far it moved since last month and the pace line says what the pace was a
  month before. The demo declares one, with a typed return, and its test
  asserts both dates land and the markets date comes first.
- ONE PLAN, SEVERAL DESCRIPTORS (2026-10-16). Banks rename a biller's
  descriptor mid-plan, and the detector keyed on the merchant string, so one
  monthly plan reached it as several merchants: each name long enough to pass
  the gates became its own subscription row, and a name only one charge long
  was listed nowhere. `brandOf` already folded such names for the yearly
  TOTAL, but by first word only, which cannot relate a product name to the
  brand that later replaced it, and never for the rows. The detector now
  follows a plan across names: a later name continues an earlier one when it
  starts after the earlier's last charge (overlapping names are two plans),
  on the same account, within the amount tolerance, sharing a word of the
  payee's NAME, and the joined series passes every gate with the handover gap
  inside the regular band (a pause and a restart are two plans). The first
  cut matched on ANY distinctive word, and `subs:audit` on a real history
  showed what that costs: a gas station and a restaurant in one town, a few
  months apart at a similar price, joined into a quarterly "plan" through the
  town's name. Two guards came out of it, and both stay. Words are the NAME
  words grouped review already settled on (its first two past the bank's
  bookkeeping, four letters or more, never a place; now shared from
  payeeWords.ts so the two cannot drift), and a chain is emitted only when one
  of its names is recurring on its own: following a plan never discovers one.
  On that history the audit's detections were otherwise unchanged. The plan
  keys on its NEWEST name, so a dismissal or a registered pattern written
  against the current descriptor still finds it, names the earlier ones in
  `aliases`, and its row says "billed under N names" so a charge count
  covering every name does not surprise beside one name. `subs:audit` reports
  such a plan once, under its newest name, as the detector does.
- MISSED BEFORE LAPSED (2026-10-16). Two cycles is the right wait for calling
  a plan gone, because billing dates wander, but it left a cancelled monthly
  plan reading as live for two months: weeks after its last charge, with the
  next billing date well past and the card syncing daily, the page
  still listed it as recurring, counted it in the next 30 days and billed it
  in the yearly total. Shortening the lapse was rejected: one late or skipped
  charge would then call a live plan cancelled and drop it from every total.
  Missed is the step between, and borrows its tolerance from the detector
  itself: absent for longer than the longest gap the detector still reads as
  the cadence (35 days for monthly), so there is no second threshold to tune.
  It is judged against how far the charging ACCOUNT's records reach
  (`accountThrough` on the payload, newest row of any kind), never the clock:
  a card imported from statements, or a feed that stopped syncing, has no rows
  past the date yet, and no charge in records that stop is not a missed one.
  Rows generated before the field existed are never called missed; the next
  sync's regeneration fills it in. A missed plan stays listed with its chip
  and "missed <date>", and leaves BOTH projections (commitments and the /yr),
  which must agree on what is still billing. A registered subscription for the
  same service is held out with it unless its own pattern found a NEWER
  charge (the bank changed the descriptor and the service still bills);
  without that a cancelled plan the operator had also registered came straight
  back as committed the moment its detected twin went quiet, and it did the
  same after a lapse, so the hold covers lapsed twins too.
- Two different notions of "the same service" exist and only one is right for
  matching a REGISTERED subscription to a charge. `brandOf` takes the leading
  word, which is correct for folding detector output ("verizon" vs "verizon
  paymentrec urring …") and wrong here: you register "Coursera" and the bank
  writes "coursera.org", sharing no first word. The subscription's own
  `merchantPattern` already decides which transactions are its charges, so it
  is the fold too — `matchesSubscription` in `health/subscriptions.ts`, used by
  `reconcileSubscription` itself so there is one definition. This matters
  because the commitments panel now totals detected and registered together:
  failing to relate them does not merely look untidy, it bills one service
  twice. Detected wins a tie (observed beats asserted) and a registered item is
  marked "declared", because the panel's stated premise is that cadence and
  amount are both observed and that is not true of one you typed in.
- Subscription thresholds are TUNED — `npm run subs:audit` before touching one,
  and expect the answer to be no. The audit reports every merchant with 2+
  charges that was NOT detected, grouped by the gate that rejected it and
  ranked by what it would cost a year if real. On 2638 real transactions, 59 of
  them, and almost every one deserves it: restaurants visited twice, TRC TAPGO
  at a 0.5-day median gap, "zelle transfer" with 1 of 9 gaps regular. Loosening
  any gate floods the list with dining, which is the same failure the anomaly
  pass already worked through. The one honest gap is ANNUAL plans — a $95 card
  fee sits at 2 occurrences because 3 yearly charges need 3 years of history —
  and closing it by admitting 2-occurrence yearlies also admits a tax payment
  and an ice cream shop visited twice a year, so it stays open deliberately.
  The merchant-string-shift blind spot is real but already handled downstream:
  Verizon arrives under three merchant strings and `brandOf` folds them.
  The audit RE-IMPLEMENTS the detector's gates so it can name which one bit, so
  any change to `recurring.ts` has to be mirrored there — it silently kept
  reporting Zego as detected after the category exclusion removed it.
- Recurring is NOT the same as subscribed. `NOT_SUBSCRIPTION_CATEGORIES`
  (`insights/recurring.ts`) drops Rent & Housing and Taxes before grouping:
  they have exactly the shape the detector hunts for — stable descriptor,
  stable amount, monthly cadence — and listing them buries the two or three
  things actually worth cancelling. Excluding by CATEGORY rather than by name
  is what demotes a rent PORTAL without enumerating portals. This reverses the
  earlier decision to ship no rent-portal rules: that objection was that a
  portal bills the convenience FEE for this operator and the whole rent for
  someone else and arithmetic cannot tell which, but that is about what the
  AMOUNT means, not where it belongs — Rent & Housing is correct under both
  readings. A `zego|paylease` rule now ships at priority 250. It does nothing
  for a database that already has user rules at ≤99 pointing elsewhere, which
  is the general lesson: a pack rule cannot fix an instance the operator has
  already hand-tuned, so simulate against the real rule set before assuming a
  pack change lands.
- "Counts as cash" is NOT the account type (`ui/liquidity.ts`). A brokerage
  account can hold a money-market balance that is spendable tomorrow, and one
  here does: it grows ~$142.55/month with no transaction behind it, which is
  interest. Retyping it DEPOSITORY is the obvious move and it is WRONG — cash
  and credit are exempt from the snapshot rule in `netWorth.ts` BECAUSE
  transactions fully explain them, and this account's do not, so net worth
  would start reconstructing it from trades and drift. Liquidity and
  market-valuation are two different questions about one account, and the
  override (`Setting` key `cash.additionalAccountIds`, set by
  `npm run accounts:cash`) answers only the first. It is a Setting and not a
  column because it is per-instance operator config and a schema change has to
  be applied to the cloud database by hand.
- `npm run goals -- --add` is NOT idempotent, and the duplicate it makes is
  quiet: slugs dedupe ("house-deposit-2") but CONTENT does not, so re-adding
  an existing goal doubles it and the same dollars count toward both. The
  read-only listing the command prints IS the guard — read it before adding.
  Paid for 2026-08-01: the cloud already held the goal (its data had been
  carried over when the feature shipped), the panel gave no sign of it (next
  bullet), and the re-add created a twin that had to be removed.
- The goals panel is gated to the month being LIVED IN, and the period
  selector clamps to the latest month that HAS insight rows — near a month
  boundary those disagree and the panel is reachable from neither. Verified
  2026-08-01: `?period=2026-08` clamped back to July until the first August
  sync wrote August rows. So a goal declared near the boundary is INVISIBLE on
  the deployment until the new month's first sync, and that absence reads
  exactly like "the data never reached this database" — the misread that
  caused the duplicate above. Check the Setting (`npm run goals` prints it)
  before concluding anything from the panel's absence.
  FIXED 2026-08-01, second half: the lived-in month is now admitted rowless
  (`selectPeriod` in `ui/periodNav.ts`, evidence in ui-and-pages.md), so the
  panel renders from day 1 and its absence once again means the Setting is
  missing, not the month. The first half stands: --add still duplicates.
- The RECONCILIATION LINE on cash goals (built 2026-08-01, the same day the
  operator caught the gap by reading their own panel): the projected landing
  divides the FUND's shortfall by the WHOLE savings rate, which silently
  assumes every saved dollar stays in cash. Measured over Feb-Jul 2026, the
  rate was $7,859.47/mo while cash itself grew $3,285.69/mo mean — the gap is
  a standing $3,628.42/mo transfer to the actively-invested brokerage
  (structural) plus card-payment timing (washes out; the structural pace is
  ~rate minus transfer, ~$4,232.29/mo). At the observed pace the $298.05k goal
  lands years later than the panel's headline date. The shared-rate footnote
  only renders with two or more projecting goals, so a SINGLE cash goal
  stated no assumption anywhere on screen — the reconciliation line is the
  only sentence that does, which is why the root rule says never to remove
  it. Computed by the caller (ui/insights.ts) as one gated aggregate over
  cash-account transactions across the rate's own window — transactions
  fully explain cash accounts (the netWorth exemption), so the signed sum IS
  the growth; nominated funds get null because theirs can hold investment
  accounts, where that arithmetic would fabricate. SUPERSEDED 2026-10-16,
  next entry: the cash definition can hold an investment account too.
- RECONCILIATION FROM BALANCES (2026-10-16). The cash definition admits an
  investment account the operator counts as cash (accounts:cash), and the
  transaction sum above then fabricated exactly as the entry warned for
  nominated funds: a money-market account books its trades and sweeps as
  rows, and the line read "Cash itself grew ~−$N/mo" for a fund whose
  balances had risen every month. Found by the Insights redesign, whose
  savings-goal chart drew the fund's month-end balances beside that line
  and contradicted it on the same screen. The growth is now read from the
  same balances the chart draws (goalFunds.ts, fundGrowthOver: month-end
  before the window to its last, per month, from NET_WORTH_GROWTH
  `byAccount`), which also spends one fewer round trip; the transaction sum
  remains only for rows stored before per-account values existed. The
  wording became "Cash itself grew / shrank ~$N/mo", never "~−$N".
  The same chart showed why a savings goal's record spans only its PACE
  WINDOW: the fund is the cash definition TODAY, and the account it now
  counts as cash held a brokerage's shares until a reshuffle, so a five-year
  line climbed to several times the fund and fell off a cliff that was never
  the fund's. Six months is the window the date is measured from, so the
  line shows exactly what the date stands on.
- The house-readiness panel (BUILT 2026-08-01, design in docs/backlog.md):
  `insights/readiness.ts` is a pure function over the same complete-month
  window goals and runway average (readiness.test.ts pins the parity), and
  its tests REPRODUCE the design's worked numbers within $5k — $6,465.61
  budget, ~$676k fund-limited, ~$880k through PMI, ~$999k/~$230k balanced —
  so any reformulation that cannot hit them is wrong, not the book. Paid for
  at build and review time: (1) PMI is strictly-below-threshold with a 1e-6
  epsilon, not 1e-9 — the fund-limited price is round2'd, a half-cent of
  rounding moves the down fraction ~4e-9 below the threshold, and at 1e-9
  the no-PMI path itself picked up $336.92/mo of PMI it does not owe. (2) The
  FLOOR_EXCEEDS_RESIDUAL refusal decides on the ROUNDED budget and folds −0
  to +0 — deciding on the raw float let a 5e-11 residue print "$0.00/mo"
  while claiming a budget exists. (3) The payment-limited price rounds DOWN,
  never to nearest: a budget landing inside the PMI jump makes the bisection
  converge to the supremum of the feasible set, and rounding UP by half a
  cent crossed the discontinuity — the returned price cost the full PMI
  increment more than the budget (adversarial review, reproduced at budget
  $4,535.53 in the jump $4,376.55→$4,714.64). (4) Non-finite series values
  refuse rather than compute — "NaN <= 0" is false, so NaN dodged the floor
  refusal and printed a NaN budget beside a $0 PAYMENT-bound ceiling;
  unreachable from JSON payloads today, guarded anyway. (5) The FUND is the
  first declared goal's assessed `saved`, and the caller gates on
  `refusal !== 'NO_ACCOUNTS'` — that refusal forces saved to 0 as BROKEN
  CONFIG, and feeding it through rendered "the $0.00 fund caps you at
  ~$0.00" as if it were a verdict. The housing subtraction matches the
  category by NAME "Rent & Housing" (case-insensitive; absent means $0
  housing, correct arithmetic) — the fixture seed names it plain "Rent", so
  seeded databases show non-housing equal to total spending unless renamed.
  Declaring is a DATA change: run `npm run readiness` once per database,
  like goals, and it requires a declared goal to exist as the fund.
- The readiness panel's PRESENTATION (two passes, 2026-08-01, operator-led):
  the healthy path renders NO prose — decision figures are a label-over-figure
  band (binding ceiling named IN its label), the budget's arithmetic is a
  LEDGER totalled at the foot (Overview's idiom applied to a derivation), and
  the five typed values collapse behind one native <details> disclosure with
  a title-attribute hover preview. The as-of date stays on the collapsed
  summary DELIBERATELY: it is the staleness alarm for a rate that would
  otherwise read current forever while hidden — do not fold it in. The goals
  rate line dropped its lowest/highest range from DISPLAY only; the analyzer
  still computes both (rateLow/rateHigh stay on GoalAssessment) so nothing
  downstream loses them. The goal's progress bar FLOORS its width to match
  the printed % — bar and figure disagreeing by a point is the two-totals
  bug class in miniature.
- The declared HOUSE PRICE is kept on the goal (`housePrice`, optional,
  2026-08-01 third pass) and renders as the readiness band's TARGET HOUSE
  cell — the operator noticed the $1295.86k the whole feature orbits appeared
  nowhere on screen. This does NOT reverse "the derivation is not kept":
  what stays out is the FORMULA (the percentages, re-run at render); the
  price is a declared aspiration stored like the target itself. The cell's
  "needs ~$X cash" sub is computed from the READINESS config's down+closing
  at render, so it tracks the panel's own assumptions rather than whatever
  the helper used at declaration time — the two can legitimately differ if
  the config changes, and the readiness assumptions are the ones every
  other number on that panel already leans on.
- The readiness RATE resolves typed-first (2026-08-02): resolveReadinessRate
  fills an absent typed rate from the stored FRED observation, stamping asOf
  with the OBSERVATION date — never fetchedAt, because the summary's as-of is
  the staleness alarm and a fetch time would make a stalled series read
  current. The stored config admits the rate pair wholly absent but never
  halved or out-of-range: a mangled typed rate is corruption and parses to
  null rather than silently falling through to the index. Rate-absence is
  entered ONLY through set-readiness's --fetched-rate flag — a first
  declaration that merely forgot --rate is refused, not opted in. With no
  typed rate and no stored observation the resolver returns null and the
  panel does not render, which is byte-for-byte the pre-fetcher behavior; the
  typed path returns the stored config verbatim, pinned by a test asserting
  toEqual on the book config, so an instance that never sets FRED_API_KEY
  cannot be changed by this feature at all. When the fetched rate IS
  operative the disclosure summary names the source and series ("rate (FRED
  OBMMIC30YF)") beside the observation date — and the FUND-limited ceiling
  does not move at all with the rate (verified to the cent across the
  swap), which is the design's own claim that a live rate refines only the
  non-binding side.
- Since 2026-08-02 the period selector also DEFAULTS to the lived-in month
  (evidence in ui-and-pages.md), so the goals and readiness panels are what
  bare /insights opens on — the gating itself is unchanged.
- A finding the DIGEST leads with is not printed again as a row below it
  (2026-08-03). The digest and the streams read the same insights, so a
  promoted one appeared twice about 400px apart, in different words and a
  different order: May's two anomalies led the page and then repeated
  verbatim-but-reworded under "Anomalies". For a CATEGORY it was worse than
  redundant — July's Groceries led with "$448.89, against $107.12 in comparable
  months" and reappeared as "total $448.89 — higher than all prior months
  (median $78.24)". Two medians for one category on one screen, 263px apart,
  both correct: the digest measures against COMPARABLE periods and the anomaly
  against ALL history. Nothing said so, which is what made it a contradiction
  rather than two facts.
  digest.ts had already decided this for the category case and only half
  applied it — "CATEGORY_TOTAL anomalies are left out: category movement is
  already covered above, and better" governed what ENTERED the digest and
  never reached what the stream PRINTED.
  Each item now carries the `dedupeKey` of what it was built from
  (`txn:<id>`, `cat:<categoryId|name:…>`), computed on both sides by the
  exported `anomalyDedupeKey` so the two cannot drift, and the page filters
  the Anomalies group by the keys the digest actually KEPT — after the stake
  floor and the four-item cap, so an anomaly that did not make the cut still
  appears below. Dismissed anomalies never enter the digest, so they are never
  suppressed by it.
  Nothing is lost in the promotion: the digest's ONE_OFF row now prints the
  RANK ("higher than 90% of your Shopping (median $132.46)") rather than its
  old "against $132.46 typical". The rank was the anomaly stream's whole
  contribution and the convention requires it — a ratio against a heavy-tailed
  median reads as a claim about what a dinner costs. Verified on real data:
  May and June promote both anomalies and the Anomalies heading disappears
  entirely; July suppresses only the Groceries CATEGORY_TOTAL and keeps the
  two transaction anomalies the four-item cap left out.

- A ONE-OFF IS NOT A TREND (2026-09-16). The demo data put a single $1,249
  electronics purchase in the current month, and /insights' digest led with it
  TWICE: as the ONE_OFF it is ("higher than all your Shopping"), and as
  "Shopping $1,249.00, against $97.24 in comparable months — $13,821.12/yr if it
  holds". The drift branch measured the category's TOTAL, which the one-off
  alone had lifted, and then annualised it — projecting a purchase that happened
  once as if it recurred every month, which is exactly what the digest's header
  says a one-off must never be. Real data had not shown it only because no
  single purchase had yet outweighed its category's median by that much.
  THE RULE: drift is measured on the category's spending MINUS this period's
  TRANSACTION anomalies in it. A category whose rise the one-off explains
  reports no drift; one that rose beyond it is scored only on the remainder,
  the part that could repeat. The one-off still reports at face value.
  CATEGORY_TOTAL anomalies are not subtracted: they describe the category, not
  a purchase inside it. Pinned in digest.test.ts: explained rise, drift beyond
  the one-off, and other categories untouched. One existing test's anomaly had
  defaulted into the very category it measured; its intent — a recurring drift
  outranking a bigger one-off — now places that one-off in another category.
- RECENT BASELINES (2026-10-16). The demo's history grew from two years to
  eleven, and two baselines that read ALL history went stale on it. Category
  drift took the median of every prior month with spending, so rent raised
  each January read "Rent & Housing $1,850, against $1,600 in comparable
  months, $3,000/yr if it holds" every month of the following year, and a
  real history of several years showed the same shape in utilities, rising
  with prices. The pace call took
  every prior year of the same month, so "a typical October ran" a figure from
  when rent and prices were far lower, and an ordinary month read as double
  its norm. Drift now measures against a category's most recent twelve
  periods with spending (digest.ts, DRIFT_BASELINE_PERIODS) and the pace call
  against the same month of the most recent three years (pace.ts,
  SAME_MONTH_YEARS). A year still holds a bounce; three Octobers still average
  one odd one out. Both read the priors OLDEST first, as ofType returns them.
- ONE-OFF PAY, AND WHAT THE INVESTING FIELD MEANS (2026-10-17). The operator
  read a saving pace far above what their pay less their spending allowed,
  and readiness income above their paychecks. Three causes, two of them
  code. (1) Bonuses: two extra payroll deposits beside paychecks in the
  pace window counted as income, and averaged in they read as a monthly
  habit. The operator's rule: pay that is not repeated over the next three
  paychecks is a bonus; flag it, and ask if unsure. Built as oneOffPay:
  REGULAR pay is the same amount (within 2%) from the same payer on three of
  the eight paydays around it, both sides counted together; a first cut
  that required three on ONE side left a raise's middle paychecks undecided,
  and a bonus that came back a month later must still not count. On real
  history the rule also caught interest (amounts that happened to repeat to
  the cent) and a lone paycheck at an odd amount: so interest and dividends
  are never judged, a payer is judged only when three in four of its
  deposits are regular, and only EXTRA pay is one-off (beside a paycheck, or
  between two paydays no further apart than usual); a deposit where a
  paycheck should be IS that paycheck. Income keeps it; every saving pace
  and readiness income leave it out and say so, and pay too recent to judge
  is left out and flagged in view ("Unexpected pay") until two more paydays
  pass without it, or it repeats and counts as regular. Every-two-weeks pay
  also means 26 paychecks a year, about 2.17 a month, which the 12-month
  pace already holds. (2) The investing field: the first cut let a typed
  investing amount change the TOTAL saved ("investing more is saving more"),
  and the operator, clearing it to zero, read their saving drop by the whole
  deposit. The saving is now the total and the investing only splits it.
  (3) Data: cards whose statements are not yet imported have no rows before
  the feed began, so older months in the window look cheaper than they
  were. That is an import to run, not code.
  (4) The window, the same day, at the operator's ask: SIX complete months,
  not twelve, and four the least to project from. Twelve was chosen so a
  bonus or a big bill moved the pace less (the entry above); with one-off
  pay left out that reason is gone, and twelve only reached back into
  older, cheaper months, pay before a raise and spending not yet imported.
  (5) Raises, the same day. The operator asked how to tell Ducat a new pay
  is the pay going forward, and noted two bonuses in consecutive months must
  never read as one. Two things changed. A raise's first paycheck had been
  left out as unsettled extra pay until it repeated: wrong, since a deposit
  where a paycheck should be IS the paycheck, so only EXTRA pay (beside or
  between paydays) is ever a one-off, settled at once, and the in-view
  "Unexpected pay" flag went with it. And a six-month average reflects a
  raise a sixth at a time, so the paces project from pay as it is NOW
  (payLevel.ts): CASH_FLOW_TREND rows carry each month's paychecks, and once
  the newest paycheck amount repeats, or the operator presses "This is my
  new pay" on the panel (Setting pay.newPay), every earlier paycheck counts
  at the new amount, its difference a TOP-UP in its month, for the net worth
  pace, the savings goal's pace and readiness income alike; a cut the same
  way. Until then a new amount counts as itself, and only a paycheck ever
  asks.
- CASH HELD vs NEW SAVING (2026-10-17). The cash line said a money market
  held about two-thirds of the cash when, at the month-end, it held nearly
  all of it: one mix,
  averaged over the pace window, weighed a lump moved in the window's last
  month as one month of seven. The average was there for NEW saving, which
  waits in checking until it moves in a lump; it was wrong for money already
  moved. So the projection keeps two cash pots: the cash held at the
  month-end earns at where it sits then, and what is saved from there earns
  at the window's average mix. The same day the operator asked for the
  inflation and cash notes to say less: one sentence each, the target priced
  in compact dollars (the demo's "~$1.65m in August 2043 dollars"), each account as its
  share and rate, and one clause for both pots when their real rates agree.
  The operator then asked for less again, with details on hover. Hover does
  not exist on the phone this is read on (CLAUDE.md), so it is a TAP: in
  view stay the four controls with a few words each, only the lines that ask
  for an ACTION (a new paycheck, idle cash, investing behind inflation), and
  ONE line of what to discount (the assumed inflation and what cash earns
  after it); everything that only explains (the pace and its one-offs and
  raises, the investing, the return's context, inflation's ten-year figure,
  cash by account, investing ahead of inflation) folds into the working-out.
  On the demo at phone width the panel below its chart went from about
  1,240px and 240 words to 890px and 100.
