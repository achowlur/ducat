# Ducat — goals, subscriptions & insights conventions

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
