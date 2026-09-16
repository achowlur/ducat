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
  accounts, where that arithmetic would fabricate.
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
