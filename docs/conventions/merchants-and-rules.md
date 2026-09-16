# Ducat — merchant & rule conventions

> Figures in this file are not real. Those present at publication are scaled by one unrecorded constant, so their ratios are exact; any added since are invented. See [publishing.md](publishing.md).

Moved VERBATIM from CLAUDE.md on 2026-08-01 (the split). This file holds the
full evidence — what each rule cost and why alternatives failed. The one-line
enforceable rules live in CLAUDE.md and point here. Additions follow the same
contract: rule line in CLAUDE.md, evidence here, never both in one place.

- A grouped-review key must be at least 3 characters. Keys become priority-50
  CONTAINS rules that outrank the whole pack and are exempt from the P2P guard,
  so a Fidelity dividend on Realty Income (ticker "o") produced MERCHANT
  CONTAINS "o" and recategorized costco, doordash and every Zelle.
- Rules match against RAW bank text, so anything derived from it must stay
  findable in it. Two bugs came from ignoring that, both making a rule the user
  had just created silently match nothing: (1) banks pad descriptions into
  fixed columns ("ZELLE TO  RECIPIENT", "WF Credit Card   AUTO PAY") while
  derived payee strings have whitespace collapsed — `rules.ts` collapses BOTH sides
  for CONTAINS/EQUALS (REGEX stays raw); (2) `payeeKey` deleted reference
  numbers mid-string, which only survives when the noise trails at the end as
  it does for Zelle — Venmo puts it between the verb and the name, so the key
  appeared nowhere in the description. It now TRUNCATES at the first noise
  marker, making the key a contiguous prefix by construction (regression-tested
  as an invariant: every derived key must be findable in its own description).
- Rules only ever WRITE, so deleting one does not undo it: every row it
  already categorized keeps that category, and a payee it marked TRANSFER
  stays out of spending. `reapplyRules` therefore returns each row as it was
  (`TxnRestore`), which is what the grouped review's undo writes back. Any
  future "remove this rule" path needs the same snapshot, or it silently
  leaves the rule's effects behind.
- Grouped review keys P2P by a payee string derived from the description, so
  two different recipients stay distinct instead of collapsing into the
  meaningless "zelle transfer" rail. Those rules match DESCRIPTION, which the
  P2P guard permits for user-priority rules.
- `installRulePack` recognizes an already-installed rule by
  `matchField|matchOperator|matchValue`, so EDITING a shipped rule's matchValue
  does not upgrade it — it installs a second rule and leaves the original
  enabled in every database that already ran the pack. Add a new rule at the
  next priority instead (why `901`/`911`/`951` exist beside `900`/`910`/`950`).
- CONTAINS never cuts a word (`containsAtLetterBoundary` in `rules.ts`), and
  the two edges are NOT symmetric. A letter BEFORE the value is always a
  coincidence — no merchant name starts half way through a brand — so
  "star|bucks", "grim|aldi", "gr|uber" and "bomb|shell" are refused
  outright. A letter AFTER is ambiguous, because "trader joe|s" is an
  inflection while "sage|brush" is a different word, so exactly ONE trailing
  letter is allowed: two lets "kohl" claim "kohler", one still reaches the
  "kohls" it was written for. LETTER and not alphanumeric is the whole design —
  banks decorate with DIGITS ("410a hanover food center", "heb #1234",
  "blizzard *us1000000001") and those must keep matching. Why it exists: the
  rule button derives its value from the merchant string, so a short merchant
  became a wildcard, and that failure is SILENT while the opposite one leaves a
  row shouting on Overview. Measured before shipping (`npm run rules:simulate`,
  which keeps both matchers so the comparison never drifts): one real row
  changed and no category moved — Starbucks simply stopped being claimed by
  a user's "bucks" rule — against 1,659 constructed collisions removed across
  579 rule values, and zero losses over 3,292 decorated-merchant probes.
  The consequence for `rulePack.ts`: a value that ENDS MID-WORD no longer
  reaches the longer spelling on its own, so the full form must be listed
  BESIDE it, never instead of it (`installRulePack` keys on matchValue, so
  editing one installs a second rule and leaves the original enabled). That is
  why `exxonmobil`, `amc theatre`, `delta airlines`, `cox communications` and
  `alamo rental` sit next to their truncated forms, pinned by their own describe
  block in `rulePack.test.ts`. Anyone adding a value that stops mid-word owes an
  entry there. `npm run rules:audit` reports any rule still matching mid-word;
  it should stay at zero.
- The pack's OWN corpus tests caught this, not the simulation against 1,030
  real transactions — three of them failed on plurals ("trader joes",
  "jimmy johns") when the rule was still symmetric. Real data cannot find this
  class: it only holds the spellings this operator has actually been billed
  under, and a merchant you have never visited cannot collide with anything.
  More months of the same data would not have helped either, since the
  ten-thousandth transaction is drawn from the same ~515 merchants as the
  first. Generated probes and the curated corpus are the instruments here;
  transaction volume is not one.
- Rule bands in `rulePack.ts`: `1-99` user, `200-299` structural (bank and
  brokerage bookkeeping descriptors — card payments, ATM cash, distributions,
  taxes), `500-529` brands, `900-999` generic words, `995` payment rail.
  Credit-card-payment patterns require a card token AND a payment token,
  because Wells Fargo appends "CARD 1234" to every debit-card purchase and
  matching `card` alone flags half a statement TRANSFER — hiding it from
  spending entirely. The ATM fee pattern is ordered ahead of the ATM
  withdrawal one ("ATM WITHDRAWAL FEE" is a fee, not cash), and short brand
  names are word-bounded regexes, not CONTAINS: "ulta" hides in "consultant",
  "avis" in "Davis", "rei" in "reinvestment", "culver" in "Culver City".
- `normalizeMerchant` also CUTS the bank's bookkeeping columns. A padded
  descriptor is MERCHANT, transaction type, reference, account holder, and
  everything after the type belongs to the bank and varies per charge — which
  shatters one payee into many merchants. Measured on 1018 real rows: "web
  pmts" made 18 distinct merchants out of one rent portal (one per reference
  code), Verizon arrived under three depending on whether the row came from the
  feed (clean payee) or a CSV (no payee at all), and 713 of 1381 merchants ran
  to four words or more. `TRANSACTION_TYPE` is evidence-based and deliberately
  short — every entry was observed — because guessing risks cutting a real name
  in half; `paymentrec urring` is not a typo, Wells Fargo splits "PAYMENT
  RECURRING" across a column boundary. It TRUNCATES, so the result stays a
  contiguous prefix, and it refuses when fewer than 3 characters precede the
  marker so a merchant that IS the marker survives ("Payroll Services Inc").
  Watch one thing when adding a marker: truncation can WIDEN an existing rule's
  matchValue, so check what the shorter value newly matches before applying the
  repair — `wf credit card auto pay` became `wf credit card`, which was safe
  only because it newly matched zero rows.
- `ABBREVIATIONS` (same file) holds exactly one entry, `crd` → `card`, and the
  bar for a second is that it MEASURABLY splits a payee. Chase's descriptor says
  "CHASE CREDIT CRD EPAY" while the feed reports the payee as "Chase Credit
  Card", so 67 rows for one card sat under two names with no prefix relating
  them — which is why the repair's prefix test correctly refused to merge them
  and an explicit expansion was needed instead. It runs BEFORE the truncation so
  an abbreviation next to a marker still expands. "fid bkg svc llc" was left alone on the
  grounds that every source spells it the same way — which is now FALSE for the
  payee and was measured so 2026-07-31: the live feed names it "Fidelity
  Brokerage Services" against the CSV's "fid bkg svc llc", 70 rows to 3. So it
  MEETS this list's own bar (it measurably splits a payee) and an expansion
  would use a name a source really does use. Still unfixed, and if that family
  is ever addressed an `ABBREVIATIONS` entry is the instrument, NOT a
  `moneyline` TRANSACTION_TYPE marker: measured, the marker collapses 27 strings
  to one and STILL leaves the payee split two ways, because `bestMerchant`'s
  prefix test correctly refuses to substitute across the two spellings.
- `repair:merchants` may fall back to the DESCRIPTION, but only when it carries
  a transaction-type marker AND yields a string that is both shorter than the
  stored merchant and a PREFIX of it. The prefix half is load-bearing and was
  added after a dry run caught the length-only version rewriting a clean "chase
  credit card" into the bank's own "chase credit crd" — one character shorter
  and plainly worse. Needed because a connector sometimes supplies a payee the
  bank already mangled ("HarborwayMgmt WEB BQXRT"), so the marker is not in the
  stored string and re-normalizing it is a no-op by construction.
- `normalizeMerchant` strips payment-processor prefixes (`tst*`, `sq *`,
  `slice*`, `dd *`, `py *`, `spo*`, `gdp*`, `fiv*`, `uep*`, `pl*`, `cl *`,
  `wl *`) so the real merchant is reachable by brand rules and groups by
  itself. The leading `\b` is what keeps "DD'S DISCOUNTS" intact, and
  stripping a PREFIX (not a middle) is what keeps the result a contiguous run
  of the original — the same property `payeeKey` needs. Only Toast, Slice and
  DoorDash also auto-categorize, via DESCRIPTION rules since the raw
  description keeps the prefix; Square and the rest bill salons and retail, so
  they get the strip and no category. Normalization runs at IMPORT, so
  `npm run repair:merchants` re-normalizes stored rows — and MERCHANT rule
  values too, or every rule still carrying a prefix silently stops matching.
- `inferAccountType` order is load-bearing: deposit words first (so "Platinum
  Savings" and "Investor Checking" at a broker stay DEPOSITORY), then LOAN
  before CREDIT (so "line of credit" is a loan), then card words, then
  investment names, and card PRODUCT names LAST — "gold" and "platinum" are
  fund names too. Without the product list "Chase Sapphire Preferred" carried
  no card word at all and counted as an asset.
