# Ducat — UI & page conventions

> Figures in this file are not real. Those present at publication are scaled by one unrecorded constant, so their ratios are exact; any added since are invented. See [publishing.md](publishing.md).

Moved VERBATIM from CLAUDE.md on 2026-08-01 (the split). This file holds the
full evidence — what each rule cost and why alternatives failed. The one-line
enforceable rules live in CLAUDE.md and point here. Additions follow the same
contract: rule line in CLAUDE.md, evidence here, never both in one place.

- Chart axes must survive their own history length. The cash-flow chart printed
  all 26 month labels into a 460px plot — about 17px each where "Jun" needs 26 —
  so they ran together as "JunJulAugSep…", and with no year marker the three
  different Junes were indistinguishable. Labels are thinned to what fits
  (stepping from the END so the newest month is always labelled) and a year
  band with dividers sits beneath. Any axis whose length grows with history
  needs the same treatment.
- Two charts on one page with DIFFERENT ranges read as a bug unless the shorter
  one says why. Net worth spans 7 months against cash flow's 26 because it
  refuses a period it cannot fully know, and the explanation was gated behind
  `netWorth.length < 3` — so at 7 months the reader saw a mismatch and no
  reason. It now names its own range and the comparison whenever it is shorter.
- `/transactions` is a LEDGER: every row must be reachable, so it PAGINATES
  (`?page=N`, `PAGE_SIZE = 100`, all time newest-first by default). Capping the
  list without paging is a data-visibility bug this codebase has now shipped
  twice — first as "1861 of 2,638 rows were simply unreachable", then again when
  a month default hid 539 rows across 8 months, because 12 of 26 months exceed
  100 transactions (mean 39, median 37, max 135) and month-stepping is not
  pagination. Paging is also CHEAPER than the alternatives: a page is ~100 rows
  of DOM however many years accumulate, and `count` was already being queried,
  so total pages cost nothing. Every filter-changing link resets `page`, or it
  lands on a page that no longer exists.
- The ledger's category control is ONE picker (`CategoryPicker.tsx`), not one
  per row. A `<select>` per row cost 19 elements (select + 2 optgroups + 16
  options) × 228 rows = 1672, which was 53.4% of the document; rendering the
  list once on demand took `/transactions` from 3132 elements to 1728 and from
  1465 `<option>` to 57. It renders in a PORTAL because the table's
  `overflow-x` container clips the other axis too. FIVE bugs in it were
  invisible in source and only appeared by driving the real page, so drive it
  after any change — and the fifth (below) was invisible in the DOM as well,
  which is the sharper lesson: reading the accessibility tree back is not
  looking at the thing. Take a screenshot, or measure the rendered rect: (1) `disabled` cannot hold focus, so disabling the trigger
  during the write blurred to `<body>` and lost your place after every
  categorization — it uses `aria-disabled` plus handler guards; (2) a popover
  that assumes its own height runs off the screen (a 579px list, 275px down an
  800px viewport), so it measures the room and caps `maxHeight`; (3)
  `mouseenter` fires when a popover appears under a STATIONARY cursor, handing
  the keyboard whichever option the mouse sat on — `mousemove` does not;
  (4) the active option starts on the row's CURRENT category and, when
  searching, on the first PREFIX match, because substring search is better than
  native type-ahead ("housing" finds "Rent & Housing") but must not lose it
  ("g" has to mean Gas, not Dining); (5) the anchor's rect must be measured
  ONCE, at open, because the anchor can be UNMOUNTED while the popover is
  still up and a detached node measures an all-zero rect. Found on the
  DEPLOYMENT 2026-08-03, in the trip picker: its `trip` button lives inside
  the row's actions menu, that menu closes on the first mousedown outside
  itself — which a portaled popover always is — so the first keystroke after
  opening re-rendered the popover against a detached anchor and floored it
  into the top-left corner (`left: 8px; top: 4px`, with a viewport-tall
  `max-height: 1546px`). Both pickers now freeze the rect in a `useState`
  initialiser beside the `desktop` check, which is safe precisely because the
  popover already dismisses on scroll and resize. Two reviews and the whole
  look-at-everything UI pass missed this, every one of them reading DOM text
  and finding it correct — the picker's options, wording and keyboard
  behaviour were right the entire time, and only its pixels were wrong.
  `GroupedReview` deliberately keeps its
  `<select>`: its choice is STAGED before a write that can rewrite dozens of
  rows, which is a different contract, and it is not on the hot path.
- ESCAPE, CLICK-OUTSIDE and FOCUS RESTORE are owed by every popover on the
  ledger, and the count is now THREE built without them: the category picker
  had them from the start, the `rule` menu beside it was given them after
  "opening one and changing your mind left it open, opening a second left
  BOTH open", and `ReimburseControl` — the last control on the row — was
  found the same way on 2026-08-12, reported by the operator with the
  evidence still on screen. Its only dismissal was its own `cancel` link, so
  two 256px panels sat stacked over the ledger, the lower one (measured at
  x 1033, y 476) covering the upper one (x 1002, y 362, 270px tall) from
  halfway down — including the candidates it had not shown yet and the
  cancel that was the only way out of it. "Only one open at a time" needs no
  coordinating state: another row's trigger is a click OUTSIDE this panel, so
  click-outside buys it. The trigger also has to stay MOUNTED while the panel
  is open — it used to be replaced by it — or Escape has nowhere to put focus
  back and the anchor is measured detached, which is the trap above.
- A control at the ROW'S RIGHT EDGE opens its panel LEFTWARD below md. The
  ledger scrolls horizontally there, and left-anchoring put 138 of the
  reimburse panel's 256px past the scroller's right edge at 375px — over half
  of it, reachable only by scrolling the ledger sideways. `right-0` with
  `md:left-0 md:right-auto` measured 0px hidden right and 3px left, desktop
  untouched. The argument is not symmetry: you have to have scrolled the
  trigger into view to click it, and right-anchoring is what lands the panel
  in that same window.
- The reimburse picker offers TWELVE candidates, not the ranker's default
  five. Score is amount evidence times date decay, so a clean 1/3-of-dinner
  three weeks back scores 0.34 against 0.3 for a shapeless "part of $X" from
  yesterday — five slots is where real matches start losing to recent noise,
  and the pinned test builds exactly that pool and asserts the clean split
  survives at an index ≥ 5. Raising it cannot move the collapsed hint, which
  takes `[0]` from a list a longer one shares its prefix with — the
  wide-pool/narrow-pool equivalence still holds. The panel scrolls at 17rem
  rather than growing, because a popover running off the bottom of a phone is
  not a longer list, it is a shorter one; and the header says "closest first"
  so a list that ends is not read as everything in the 45-day window.
- The `?category=` filter takes a LIST, and `src/lib/ui/categoryFilter.ts` is
  the only place its format is written or read — link builders and the page
  share one encoder/decoder so they cannot drift. It exists because the donut's
  "Other" slice is a SET (everything ranked below `TOP_SLICES`, 8 categories and
  $2005.74 in July 2026) and WHICH categories those are changes every period, so
  a link has to enumerate the ids for the month on screen. The list is an
  INCLUSION list: an exclusion list would silently swallow any category added
  later. `null` in it is the Uncategorized BUCKET, not an absence — which is
  the distinction the donut used to lose, since "Other" and "Uncategorized"
  both carried `categoryId: null` and the href builder skipped the param when
  it was null, so clicking either drilled into the whole ledger instead of the
  slice it had just drawn. Slices now carry `categoryIds`, and `categoryId` is
  gone so the mistake cannot be repeated. Two consequences on the page: the
  multi-id group goes in `where.AND`, because `q` already owns top-level `OR`
  and the two would overwrite each other; and a list matches no `<option>`, so
  the select grows a synthetic "N categories" entry — without it the control
  read "All" while a filter was applied and submitting the form silently
  dropped it.
- Chart discipline (src/components/charts): charts are HAND-ROLLED SVG — no
  chart library, and no webfonts anywhere in the app (both would breach the CSP
  and the no-third-party rule). Axis scales must enclose the data (`niceTicks`
  guarantees last tick ≥ max — regression-tested), and value labels are
  collision-checked against every mark, never drawn over one.
- Overview's shape is HEADLINE → DETAIL → TOTAL, in that order, and the
  grouping figures are NOT table rows. Cash/Investments/Owed shipped first as
  subtotal rows inside the account table and the operator reported them missing
  while looking straight at them: same table, same alignment, a fainter grey,
  so a summary answering a different question read as another account. They are
  now a full-width band BELOW the two-column body, under a heavy rule, because
  a ledger totals at the foot of the column it sums — placed above the accounts
  they read as an interruption of the two things they belong between, and the
  table ended abruptly with no foot. The runway hangs off CASH, being a
  statement about that number and nothing else. Balance freshness likewise gets
  its own COLUMN rather than a badge appended to the account name — a column is
  scannable and is present whether or not anything is late, so the absence of a
  warning is visible too.
- Overview's right column carries SPENDING then NEEDS REVIEW, and the second
  exists because decision 1 gave this page "what needs review" and nothing was
  rendering it. It used to be a red banner in the header shown only when the
  count was non-zero, so a clean instance said NOTHING — and "all clear" cannot
  be told from "not checked" if it is never stated. It renders in both states
  and the quiet one is the point. It also balances the column heights, which is
  the honest fix for the empty right side; enlarging the donut was considered
  and rejected, since a bigger ring is decoration rather than information.
  (Amended 2026-09-16: the ring DID grow, but because it now names more
  categories — see OVERVIEW NAMES EVERY CATEGORY WORTH A SLICE. Size alone is
  still not a reason.)
  Uncategorized rows outrank a stale balance in it: they silently understate
  every spending total, where a stale balance is merely old. The same condition
  deliberately appears at three levels of specificity — provider strip, account
  row, review panel — which is escalation, not duplication.
- Overview's per-account "Nd behind" measures the balance against the LAST
  SYNC, not against now. The two failures are different and only one belongs on
  a row: if nothing has synced for a week every balance is a week old, which is
  the sync's problem and the header already says so. What a row can say that
  the header cannot is "the sync ran and this account did not move" — how Chase
  looked while frozen, fresh everywhere else and four days behind there.
  Measured from now instead, it marked 18 of 21 rows the moment local fell two
  days behind, which is noise. The chip at `staleBalanceDays` is the alarm; the
  faint text from `STALE_DISPLAY_DAYS` is legibility only, and the gap between
  them is deliberate — a frozen connection is visible on day 2 and shouted
  about on day 6.
  `/accounts` re-earned this bug independently and was fixed on 2026-08-03: it
  computed its own `daysSinceBalance` from `now` and printed it as
  "stale · Nd", so the two pages measured one fact against two clocks and
  agreed only while the sync was current. It now prints `balanceLagDays`
  against the last successful sync, from the same query Overview makes, joined
  to the existing `Promise.all` so the anchor costs no latency. The CHIP still
  fires on health's now-based `staleBalanceDays`, exactly as Overview's does —
  the split between a now-based alarm and a sync-relative number is the
  original design, not an oversight. What changed besides the number is the
  tooltip: it read "the provider feed may have silently stalled", which is a
  diagnosis this page cannot make — a late sync and a frozen feed produce the
  same stale balance, and only the header can tell them apart. It now carries
  both clocks and names no cause. `/accounts` still has NO last-sync line of
  its own, which is what makes the sync-relative number harder to interpret
  here than on Overview; that gap is open (docs/backlog.md).
- The POLISH pass (2026-08-03), the last of the five waves. Grouped by what
  each item actually was, because the list read as 38 unrelated things and was
  not:
  STRUCTURE. Six tabs had four different answers to "what is a section
  heading" — `<h3>` at 0.72rem/0.14em on Overview, Trends and Insights (three
  separate local copies of one function), `<h4>` at 0.68rem/0.13em on
  Providers, a styled non-heading on Accounts, nothing at all on
  Transactions — and NO tab had an `<h1>`, so every outline began at level 3
  or 4 under nothing. One module now (components/ui/headings.tsx): a
  visually-hidden h1 per tab (the nav carries the visible name, and a nav
  active state is an affordance, not a heading), SectionTitle at h2,
  SubsectionTitle at h3 for /providers' per-connector parts, whose connector
  NAME became the h2 those parts belong under — navigating by heading gave
  "Residual risks you are accepting" three times with nothing saying which
  connector owned them. Every `th` carries `scope`, and the eight account
  selects and links that all announced the same thing now name their account.
  HOVER IS NOT AN AFFORDANCE. Load-bearing text lived in `title=` on five of
  six tabs, and touch has no hover: the runway's variability range (a
  projection to one decimal over months that ran $3,125.52–$13,746.27, a 4.4×
  spread, qualified nowhere else), the coverage notice's full account list
  behind "+6 more" on the very notice whose job is to say what is missing, and
  the ASSUMED disclosure, whose native marker was hidden so nothing at all
  said five numbers were one tap away. All three are now text or a real
  disclosure. The merchant actions menu got the Escape, click-outside and
  padded close target its sibling picker has had since it was built — opening
  one and changing your mind left it open, and opening a second left both.
  ARITHMETIC THAT SHOWED. Shares rounded independently summed to 101%
  (49+21+11+8+7+4+1 in June 2026); they round by largest remainder now. Four
  cash-flow bars carried a NEGATIVE SVG height — invalid, so the element never
  rendered and a net-refund month read as "spent nothing" beside a tall income
  bar; clamped, with a below-axis stub so the two states differ. A flat
  sparkline normalised every point to zero and drew along the FLOOR, reading
  as "at its low" when the truth was "unchanged" — mid-height now — and its
  aria-label announced the 12 points drawn beside a visible "34 snapshots".
  DATED, NOT HYPOTHETICAL. The net-worth axis labelled every month
  unconditionally and had no year band. Comfortable at 7 points; mobile
  spacing is 246/(n−1) against 17-18px labels, so it touches at n=13, and the
  series began 2026-01 and gains one a month — January 2027. It now shares
  `labelStepFor` with the cash-flow axis, which takes the SPACING rather than
  the count, because bars occupy n slots and line points sit at n−1 intervals.
  Tooltips gained their year: the axis thins labels and carries a year band
  precisely because "Jun" appears three times, and the tooltip — the only
  place exact figures live — printed the bare month.
  UNITS AND WORDS. `titleCase` treats a dot as a word separator, right for
  "St. Louis" and wrong for a domain, so subscriptions read "Coursera.Org";
  the suffix list is guarded with `(?![a-z])` so "Coring Services" survives.
  /providers printed "0 accounts" over a CSV importer that had brought in 2128
  transactions (it targets EXISTING accounts, so its count is correctly zero
  and semantically useless) and over a rate index that will never have one —
  and called FRED's last FETCH a sync. The ledger's row count gained a
  thousands separator beside amounts the same page formats with one. The FLOW
  select read "All" while Uncategorized was quietly applying
  `flow: { not: TRANSFER }` — the same dishonesty the category select's
  synthetic entry was invented to kill, one control to the left.
  THE MIRROR OF OVERVIEW'S REVIEW PANEL. That panel had to learn to STATE
  "all clear" rather than imply it by absence. The ledger's "group by payee"
  pill had the opposite failure: the boldest control on the page urged you
  into a backlog empty for months, so "there is work" could not be told from
  "there is none". Gated on `reviewPool`, which was already queried.
- The /trends PROPORTION pass (2026-08-03) answered the backlog's own open
  question. `lg:grid-cols-2` sized the page in inverse proportion to what each
  block had to say: at 1652px the cash-flow chart — 26 months and growing —
  got 534px, 18.2px per month with its axis type scaled to 10.3px, while the
  seven-point net-worth line got the full 1104px and 376px of height. A 9.2×
  inversion, and it got WORSE as the window widened, because at a 900px
  viewport the two-column rule has not engaged and the same chart has 837px.
  All three blocks are full-width rows now. Two caps came out of measuring the
  result rather than predicting it: the category table at 640px (it was 280px
  inside a 534px section, sharing the row with the donut; `flex-1` in a
  full-width row stretched four columns across ~850px and read as sparse), and
  the cash-flow strip at 880px — an SVG scales its whole viewBox with its
  container, so at 1104px the factor is 2.12 and the 10px axis type renders at
  25px, LARGER than the page's body text, in a chart 480px tall. At 880px the
  factor is 1.69: ~20px type, 30px per month, 13 labels with a 30px minimum
  gap and no collisions. Width buys legibility and then overshoots it.
  The `vs prev` column became the prior period's DOLLARS. As a ratio it
  carried five value forms in six rows — a percentage, a `×N.N` multiplier
  above +999%, `new`, an em dash, and `+0.00%` — so a reader scanning it
  changed units per row with no key on the page. THREE of those existed only
  because a ratio has cases a quantity does not: the multiplier for a base
  near zero, the dash for a base that was not positive, and (added hours
  earlier, then removed here) a word for a current period that ended in
  credit. Dollars have none of them; the reader compares two adjacent money
  columns, which is what the ratio was standing in for, and `new` survives as
  the one genuine non-quantity. October 2025 makes the case: `spent −3,353.00`
  against `prior 12,059.19` says what happened, where `−127.80%` and even
  `refunded` did not. This retires the `×N.N` branch, unchanged since the
  original /trends commit and undefended since it was written.
  Overview's NEEDS REVIEW panel became a grid child in its own right so it can
  hoist above the account table below md — but ONLY when it has items.
  Measured unscrolled at 375px it began 1.18 screens down, so everything the
  front page says about what needs attention was below the fold; hoisted it
  starts at 296px. The quiet "all clear" state does NOT move: HEADLINE →
  DETAIL → TOTAL is the documented shape, and reordering it to promote a panel
  that says nothing is wrong would cost the shape and buy nothing.
  The transfer row's `opacity-60` moved off the row and onto the merchant and
  account cells. At row level it dragged the AMOUNT to 3.45:1 and the
  `transfer` cell to 2.36:1 in sepia — failing AA and the 3:1 non-text bar in
  all three themes — and that cell stopped being decoration on 2026-08-02,
  when its own text became the trip trigger. The backlog's argument for
  dimming ("a plain 'transfer' span… the label is decoration on a row that
  carries no decision") predates that change, and its tooltip mitigation was
  always desktop-only. Measured after, across sepia/light/dark: trigger
  4.96/5.76/5.37, amount 6.49/10.29/7.64, merchant label still dimmed at
  3.46/4.86/12.87 — which is the part of the argument that survives.
  Watch the sub-line: below md the amount lives INSIDE the merchant cell, so
  dimming that cell reintroduced the same defect one element lower (2.71:1)
  before the opacity was moved onto the label span itself.
  The pager renders above AND below the table, and gained `first`/`last`. It
  existed only at the top of a 4,172px page — you read 100 rows, reached the
  bottom, and found nothing there. A numbered page list is the obvious third
  option and the one this page cannot afford (the category picker's DOM
  lesson). Adding two links overflowed the count strip at 375px by 78px, so
  that strip and the pager both wrap now: it was already four narrow smears of
  vertical text before the links existed.
  /providers' SYNC HISTORY moved LAST in the DOM. On a phone it sat between
  the status line and the trust card — 1,799px, 2.22 screens, between "All
  signals normal" and the words "Data path", on the page whose whole job is
  the trust story. Now 115px. Desktop is unchanged by explicit grid placement.
- The PHONE pass (2026-08-03) finished what the 2026-07-26 tap-target commit
  started. That commit swept /insights, /trends, the nav and the dismiss
  button; Overview, /transactions, /accounts and /providers were never
  touched, and /transactions alone carries more controls than the other three
  combined — 215 of them, not one clearing 44px in both dimensions. The
  shared instrument is `.tap44` (globals.css), and it is min-height ONLY,
  deliberately not the padding/negative-margin pair the header uses: that
  buys a bigger hit area at constant layout, which is right where there is
  padding to absorb it and wrong in a ledger, where it would stack 44px
  targets inside 50px rows and let neighbours overlap — the failure the
  dismiss button took its height honestly to avoid.
  Three findings shared one root: a strip with `.scroll-x` (scrollbar hidden
  by design) opening at `scrollLeft: 0` while everything worth reading sat at
  the other end. The NAV put the active tab 290px past its right edge on
  /providers, so on three of six tabs a phone reader had nothing at all
  saying which tab they were on — the underline is the only marker, and
  `aria-current` was absent too, so assistive tech had nothing either. The
  CASH-FLOW chart opened on mid-2024 with every y-axis label, the year
  caption, all four current-year months and the collision-checked latest-month
  callout off-screen: a chart with no scale showing. Both now open at the end
  that matters; the nav centres its active tab when there is room, and sets
  `scrollLeft` directly rather than calling `scrollIntoView`, which walks
  ancestors and would scroll the page to reach a nav at the top of it.
  The LEDGER's mobile spine was documented as date/merchant/category/amount
  and did not fit: 438px of columns in a 327px scroller put the entire AMOUNT
  column 111px past the edge, so a row showed date, merchant and category and
  neither the number nor its direction — on the one screen that exists for the
  number. The amount moved into the merchant sub-line, which also rescued the
  flow word (truncated away on 96 of 100 rows, taking the direction with it;
  it leads that line now and the account name absorbs the truncation).
  Measured after: amount visible on 100 of 100 rows, category trigger visible
  on 100 of 100, body never scrolling sideways. What is still off the edge is
  the TAIL of the category cell (374px against 327px), and that was ranked,
  not overlooked: wrapping the cell fixed the width and took the median row
  from 57px to 107px — a 100-row page from 6,213px to over 10,000px — to save
  33px of the SECONDARY way into a menu, and hiding `rule` below md would have
  removed the only route to trip tagging and bulk categorization, which is
  exactly what bulk review on a phone is for.
  /accounts' Type column was the same mistake in miniature: the page's own
  comment already committed to dropping columns below md and Type was left in,
  so the table needed 363px in 327px and the row's only action — the link into
  its transactions — was clipped by more than half. Type is a rare correction
  made once, on a desktop. Dropping it takes the table to exactly 327px.
  The header's right cluster (mode badge, theme, Lock) is `hidden sm:flex`, so
  below 640px there was no way to lock the app or change theme at all. It
  cannot simply be revealed — at 375px the three theme buttons plus Lock leave
  the six-tab nav about 107px of 327px — so the same controls get a
  mobile-only footer. A second header ROW was rejected: the active tab's
  underline sits on the header rule through a negative-margin pair, and
  anything above the nav would have taken taps into that 13px reclaimed area.
- Dates vs INSTANTS are formatted differently and both are deliberate. A
  transaction date, a month label and a projected renewal date are pinned to
  `timeZone: "UTC"`, because the feed mixes noon UTC, 04:00 (midnight Eastern)
  and true instants — re-zoning a date would move correct ones by a day. A real
  instant ("synced …") goes through `dateTime()` in `ui/format.ts`, which renders
  local wall-clock and ALWAYS appends the zone name: without it a UTC timestamp
  reads as local and is silently four or five hours wrong, which is how
  "synced 02:59" was really 10:59pm. Safe because period keys and bounds use
  `Date.UTC`/`getUTC*` exclusively and nothing in `insights/`, `sync/` or
  `health/` touches a local-time accessor, so no display zone can move a month
  boundary. The zone comes from `DUCAT_TIMEZONE` and NOT `TZ`: Vercel refuses
  `TZ` as a reserved variable name, so the standard mechanism is unavailable
  exactly where it is needed. Unset locally, the machine's zone is used.
- /insights admits the month being LIVED IN even before it has insight rows
  (`selectPeriod` in `ui/periodNav.ts`) — and ONLY that month; every other
  rowless period still clamps. The period list derives from stored rows and
  analyzers emit only ACTIVE periods, so on the 1st of a month every request
  including an explicit `?period=` clamped back to the prior month, hiding
  pace, commitments and goals on exactly the day the forward-looking ones
  answer the most — none of which needs a row FROM the month (commitments
  read detected/registered subscriptions, goals read balances plus PRIOR
  months' cash flow). The DEFAULT stayed the latest month WITH rows at
  first — the empty month was a step through `›`, not where the page
  opened — REVERSED 2026-08-02, next bullet. On the empty month the
  digest's quiet line says "nothing recorded yet", NOT "nothing needs your
  attention" — the second is a claim the engine LOOKED, and all clear cannot
  be told from not checked. One `now` drives both the admission and the
  current-period gate, or a render straddling UTC midnight admits one month
  and gates another — the two separate `new Date()` calls were a real latent
  bug found during this fix (2026-08-01).
- The /insights DEFAULT was reversed on 2026-08-02: the page now opens on
  the month being lived in, not the latest month with rows. When the
  admission rule shipped (2026-08-01), the default deliberately stayed on
  the latest month WITH rows, because the rowless current month held exactly
  one quiet line — landing there would have opened the page on nothing. That
  premise has expired: goals, the reconciliation line, house readiness, the
  pace call and the commitments window have since made the current month the
  page's RICHEST view, and every one of those panels is gated to exactly
  that month — so the old default hid the page's best content every
  month-start, on precisely the days the forward-looking panels answer the
  most ("due in the next 30 days" peaks in value on day 1). Verified on real
  data 2026-08-02: bare /insights on an August with zero rows renders
  commitments, a goal with its projection and reconciliation, and the full
  readiness band — against the one "nothing recorded yet" line the old
  default was protecting the reader from. Prior months stay one `‹` away,
  their full historical view intact. The admission clause is untouched: only
  the lived-in month is admitted rowless, every other rowless period still
  clamps (now to the lived-in default), and one `now` drives admission and
  every current-period gate in a single render. The clock-skew case is
  test-pinned: rows AHEAD of the lived-in month stay reachable through `›`
  without moving the default.
- Overview's net-worth headline is LIVE — the plain signed sum of current
  account balances, the sign convention's own definition — and carries no
  month label, because the old headline was the two-totals bug class on the
  front page: it printed the latest NET_WORTH_GROWTH row's figure (July's,
  all August long) directly above today's account table, two instants
  presented as one state, coinciding on the 1st and drifting apart with
  every sync. The month-over-month delta and the market-movement line
  survive as CONTEXT, explicitly labeled ("July 2026: ▼ 2.36% ·
  −$18,935.72 of July's change was investment market movement (not
  income)"), read from the latest COMPLETE month's row — strictly before
  the lived-in month even when a partial-month row exists, because a
  partial month's growth figure drifts all month and the context's job is
  to be a settled fact under a live headline. No row means the context
  lines are absent and the live headline stands alone (the empty-series
  rule); the market-movement line itself is verified load-bearing — it was
  RELABELED with its month, never removed. The estimated-balances note
  moved into the context and is scoped to the context's month: it
  qualifies that month's insight figures, not the live sum, which is read
  straight from the accounts and reconstructs nothing.
- Overview's spending block shows the month being LIVED IN, never a past
  month — the donut's hole says "this month", and in August it captioned
  July's ring, the same lie in miniature. The block renders in the empty
  state: "Nothing recorded for <month> yet — spending appears with the
  month's first sync" (a coverage claim, deliberately not "nothing needs
  attention" — the engine has not looked at a month no sync has reached),
  with the latest complete month one quiet link away ("July: $11,060.02 →"
  into /trends for that period). Both printed figures come through
  spendingBreakdown, the single source of every printed total, so no
  second summation exists. The "full breakdown →" link renders only when
  the lived-in month has a row, because /trends silently clamps a period
  it has no row for, and a link that lands somewhere it did not name is
  worse than no link. A month whose reimbursements outran its spending
  prints the net figure rather than a false "no spending". ONE `now` (UTC,
  via periodKey) drives the page's current month, the runway's
  complete-month cut and the context's completeness boundary — the runway
  previously derived its own from a second `new Date()`, the same latent
  straddle-midnight split /insights had already paid for.
- The trip UI (2026-08-02) re-earns none of the category picker's four bugs
  and none of the DOM lesson: ONE portal picker (GroupPicker.tsx) with
  aria-disabled triggers, measured viewport room with flip,
  mousemove-not-mouseenter, and a keyboard start on the row's current
  label. An UNTAGGED row's picker starts with NOTHING active — the
  adversarial review caught the fallback-to-first-label making bare Enter
  an accidental tag, the exact write the start-position promise exists to
  prevent; ArrowDown from that start lands on the first row, ArrowUp on the
  last. Overlong labels die in normalizeGroupLabel (null past
  MAX_GROUP_LABEL), so no create option is ever offered past the cap and
  the action's own throw is a backstop for hand-crafted requests, not a UI
  path. A tagged row carries one chip, an untagged ordinary row carries
  NOTHING (its way in is the on-demand actions menu), the transfer cell's
  own text became the trigger at zero element cost, and only the
  linked-reimbursement row shape pays (+2 elements — measured 1483→1485
  non-script on a 100-row page, reproduced independently by the review).
  `?group=1` was already the payee-review mode, so that mode moved to
  `?payees=1` — a param name is an API, and the collision would have made a
  trip named "1" unreachable; the repo-wide grep found zero stale uses. The
  label round-trip (space + apostrophe: "Tess's March trip") is pinned from
  href through URLSearchParams to the parse and was driven through the
  picker, the band, and the /insights link on real data. The /insights
  TRIPS section costs exactly +1 round trip (a 4-column findMany joining
  the existing Promise.all), which an untagged database also pays — a gate
  would itself be a query. The totals band aggregates the WHOLE filter, not
  the visible page, consistent with Overview's band idiom.
- The band's RENAME control (2026-08-03, built within hours of the operator
  hitting the per-row ceiling at two rows): renameGroup rewrites the label across the
  WHOLE group in one updateMany — never the filtered subset the band
  happens to sum, because renaming only the visible rows would silently
  split the trip — and its scope line prints the group's true row count
  from a deliberately UNfiltered count query ("N in total, filters or
  not"). Renaming onto an existing label MERGES the two groups, allowed on
  purpose (two half-named trips are a real state); the note appears the
  moment the typed name matches one, before anything is written, and a
  case-insensitive match adopts the existing casing — client-side for the
  note, and enforced SERVER-side at write time, because the client's label
  list can be stale against another session and the write is what must not
  fork a case-variant (the action returns the label it wrote; the client
  navigates to that). After a rename the client lands on the renamed
  group's URL, because the old ?group= would show the honest-but-jarring
  empty band. A plain rename is reversible by renaming back, with no
  snapshot machinery — a label exists only as the value on its rows, so
  there is nothing else to move — but a MERGE is not reversible: the
  partition between the groups is gone, which is exactly why the warning
  comes before the save. The write is shared with the tests through
  renameGroupRows (sync/groups.ts) — the restoreTransactions pattern — and
  the invariant extends to it: rename + regenerate stays byte-identical,
  pinned beside the merge and same-name-no-op cases.

- /providers SYNC HISTORY PAGINATES at five rows (2026-08-04, operator ask).
  The original shape — `take: 20` with nothing reachable past 20 — was the
  capping-without-paging bug /transactions shipped twice, latent here because
  SyncLog outgrows 20 within a month of nightly syncs and the overflow was
  silently invisible. Five rows answer "did last night work"; the pager
  (`?logs=<connector>&logsPage=<n>`, clamped into range, one connector paged
  at a time) reaches every older row. Same pager idiom as /transactions:
  ‹ newer / older › with disabled spans, page X of Y, tap44.

- An SVG `<title>` takes ONE string child, never two (2026-08-04). MiniDonut's
  slice tooltip was written as two JSX children — the label/percent template
  and a conditional `" — view transactions"` — which JSX compiles to a
  two-element `children` array. React serializes a `<title>` from `children`
  only when it is a single string: `pushTitleImpl` coerces
  `Array.isArray(children) ? (children.length < 2 ? children[0] : null)
  : children`, so an array of two becomes `null` and the server emitted
  `<title></title>`, in place, while the client rendered the text. That is a
  hydration mismatch, and its blast radius is the whole document — React's
  recovery re-renders from `<html>` down, which discards the `data-theme` the
  pre-paint script in layout.tsx had stamped there and re-inserts that script
  as a DOM node (inserted scripts never execute), so the attribute never comes
  back. Overview was the only page drawing a donut, so Overview was the only
  page that ignored a saved light/dark theme and rendered sepia — the `:root`
  fallback — for everyone else.

  The diagnosis is the lesson, three times over. First, THE DEV SERVER
  TERMINAL WAS ALREADY SAYING IT: React logs the exact cause and the exact fix
  ("try rewriting it using a template string") once per rendered slice, on the
  server, where nobody was reading. Check that terminal before the browser
  console. Second, the browser console's own claim was a red herring —
  `data-theme` missing from `<html>` looks like the cause and is actually the
  CONSEQUENCE, and `<html>` already carried suppressHydrationWarning, which
  covers attributes and would never have produced this. The real node only
  appears in the dev overlay's tree diff, which the console message truncates;
  open the overlay (or read `[data-nextjs-dialog]` inside `nextjs-portal`'s
  shadow root) for the diff and the file:line. Third, "every page is broken"
  was one page: the overlay badge and the console both persist across SOFT
  navigations, so an error on `/` follows the reader to `/providers` and
  `/insights`; and `/login` REDIRECTS to `/` when the gate is off, which is
  how the login screen appeared to fail too. Hard-navigate each route before
  believing a bug is global — only `/` ever threw.

  PRODUCTION HAD IT TOO, silently: the coercion is identical in the production
  React build, so the deployment served the same stripped theme with only a
  minified `#418` in the console and no overlay. "Prod looks fine" was the
  interactions working — hydration failure is RECOVERABLE, so handlers do
  attach and clicks do work, in dev as well. Whatever made handlers dead in
  dev was the corrupted-`.next` failure documented in CLAUDE.md, which is a
  different bug with an overlapping symptom; a clean worktree checkout never
  reproduced it. Pinned by MiniDonut.test.ts, which asserts on the SERVER
  MARKUP because neither the source (the JSX reads as one string) nor the
  hydrated DOM (the client tree is correct) shows the defect. That test is
  also why the repo now has a vitest.config.ts: tsconfig sets `jsx: preserve`,
  so vitest could not import a .tsx component at all.

- A DATABASE THAT CANNOT BE REACHED SAYS SO (built 2026-08-06, from the
  2026-08-04 outage). Turso's us-east-1 router answered every query with HTTP
  502 for over two hours, and every page fell through to `app/error.tsx` —
  which says "Something went wrong", the same words it shows for a null
  dereference. The app was indistinguishable from broken code: diagnosing it
  took a Vercel log read, a probe of `/api/diag/timing`, and finally the Turso
  console failing to connect from the operator's own browser. The page could
  have said it in one glance.
  Now it does. `src/lib/ui/dbHealth.ts` classifies a caught error;
  `withDatabaseNotice` (components/DatabaseNotice.tsx) wraps each page's render
  and swaps in `DatabaseUnavailable`; anything the classifier does not
  positively recognise is RETHROWN, so an ordinary bug still looks like a bug —
  trading one indistinguishable failure for another would buy nothing.

  WHAT THE COPY MAY AND MAY NOT CLAIM, which is the actual design:
  it NAMES NO CULPRIT — a provider incident, a revoked token and a lapsed plan
  are the same silence from here, so the page prints what it OBSERVED (the
  host, the HTTP status or transport code — the two facts that cost a log read
  to recover) and stops. It NEVER IMPLIES THE DATA IS GONE: failing to reach a
  database is a failure to SERVE and says nothing about what is stored. And the
  missing-table state carries NO such reassurance, deliberately — a table that
  is not there is a real absence, and "nothing was lost" there would be exactly
  the fabrication `known:false` and the null `pctDelta` exist to refuse. Advice
  is mode-scoped, which is the second reason this cannot live in the boundary:
  "it may be temporary, try again" is right for a cloud outage and useless for
  a checkout that was never migrated.

  WHY NOT `app/error.tsx`, since that is the obvious home. Two structural
  reasons, both verified against next 15.5.20 in this repo's own node_modules.
  (1) In PRODUCTION the message never crosses the wire: `create-error-handler`
  replaces it with a digest, and the client rebuilds a fresh Error reading "The
  specific message is omitted in production builds…". So a boundary cannot tell
  a 502 from a null deref. (2) It is a `"use client"` component: it cannot read
  `DATABASE_URL` or `isCloudMode()`, so it cannot give the advice that fits.
  The boundary keeps its Server-Action job (security-and-auth.md) and is not
  the thing being replaced. FOUND WHILE PROVING THIS, and left standing as its
  own item in docs/backlog.md: the same redaction makes error.tsx's own
  `/not authenticated/i` branch dead in production, so the "Session expired"
  heading and its Sign-in link — the one failure that boundary's comment says
  it exists for — can never appear on the deployment.

  THREE MEASUREMENTS THAT CONTRADICT THE OUTAGE NOTES, taken 2026-08-06 against
  @prisma/client 7.8.0 + @prisma/adapter-libsql across eleven scenarios. Do not
  re-derive them from the original entry, which was written from one Vercel log
  line and generalised.
  (1) `code` IS NOT A DISCRIMINATOR. The recorded `P2010` is real but belongs
  to the RAW path — `$queryRaw`, i.e. `/api/diag/timing`, which is where the
  operator was looking. A model query throws a bare `DriverAdapterError` with
  no `code` property at all. And `P2010` fires just as happily for a SQL typo
  against a perfectly healthy database (measured), so keying on it would have
  put "the database is unreachable" on top of a query bug.
  (2) `P1001` and `P1017` CANNOT FIRE through this adapter. Prisma raises them
  only for `cause.kind` of `DatabaseNotReachable` / `ConnectionClosed`, and
  `@prisma/adapter-libsql`'s error mapper never returns either kind. A branch
  for them would be dead code, so there isn't one.
  (3) TIMING IS NOT A DISCRIMINATOR EITHER. The notes recorded 6-10 seconds as
  the tell that separates an unreachable database from a misconfiguration; that
  is the undici CONNECT TIMEOUT and only appears for a blackholed host (10.7 s
  measured). An answering-but-failing edge takes ~2.2 s and a DNS failure ~90
  ms — so "slow" spans 11 ms to 10.7 s across the unreachable cases alone.
  What DOES discriminate is the MESSAGE chain, plus one gate: `clientVersion`.
  A dead Turso host and a dead FRED host both throw a byte-identical
  `TypeError: fetch failed` with an `ENOTFOUND` cause, and the only difference
  is that Prisma stamps `clientVersion` on anything it rethrows from a query.
  Without that gate a failed rates fetch inside the same try block reports
  itself as a database outage — measured both ways, not theorised.

  AND THE BIGGEST ONE: A MISSING `data/ducat.db` DOES NOT FAIL. libSQL CREATES
  the file, so local mode's real symptom is `no such table: main.Setting`
  against a brand-new empty database — not a connection error, and it silently
  leaves an empty file behind. `prisma.$queryRaw\`SELECT 1\`` even SUCCEEDS
  against it, so `/api/diag/timing`'s connect probe cannot detect this state at
  all. That is why there is a fourth kind, `no-tables`, with its own wording
  and its own advice. The only local case that genuinely fails to OPEN is a
  missing PARENT DIRECTORY, and it arrives with `code: ""` — the property
  exists and is falsy, so a predicate written as `if (e.code)` skips it in
  silence.

  WHAT ADVERSARIAL REVIEW CAUGHT, all of it the same mistake — copy asserting
  more than the error observed — and worth keeping because the first draft read
  as careful and was not.
  (a) `no-tables` said "this app's schema has never been applied to it". One
  missing table cannot support that: a database ONE RELEASE BEHIND throws the
  identical error while holding a year of real transactions, and that is not a
  hypothetical here — it is the `schema:push` split this repo documents as a
  routine hazard (reproduced against a real database with the init migration
  applied and the later ones withheld: `account.findMany()` returned a row,
  `trackedSubscription.findMany()` threw). It now names BOTH readings, because
  the evidence distinguishes neither.
  (b) The cloud advice offered `schema:push` alone, and `schema:push` REFUSES a
  database with no tables at all — so the empty case was handed the one command
  that cannot work on it. `turso:push` leads now, with `schema:push` for a
  database merely behind.
  (c) The cloud advice also explained a name typo as "an empty one is created
  on first contact" — true of a local `file:` path, false of Turso, where a
  name that does not exist is refused and surfaces as UNREACHABLE instead. The
  local sentence was correct and stayed; the cloud one was carried over
  unexamined.
  (d) `unopenable` blamed a missing folder. SQLITE_CANTOPEN (14) is the whole
  report and covers a directory, a permissions refusal and a missing parent
  alike, so it now says the OPEN failed and lists where to look.
  (e) "Try again" dropped the QUERY. Middleware's `x-app-path` is the pathname
  only, so retrying from `/transactions?payees=1&period=2026-03&page=4` landed
  on page 1 of the unfiltered ledger — the one control whose entire job is to
  re-ask the SAME question, silently asking a different one. The query travels
  in its own header (`x-app-query`) rather than widening `x-app-path`, which
  the layout compares against `"/login"` and which `/login?error=1` would break.
  Note what the component test could NOT catch: it hands `path` in, so it pins
  the rendering and never the wiring that produces it.

  ASSERT ON WHAT IS PRESENT, NEVER ON WHAT IS ABSENT. This nearly produced a
  false verification twice during the outage: every probe was written to check
  that the old text was GONE, and an absent-string check passes on a page that
  failed to render entirely — which is the state under test. Both the login
  redirect and the error boundary came back "clean" that way. So
  `DatabaseUnavailable` takes its four facts as PROPS and is pure and
  synchronous — no `headers()`, no `process.env` — purely so its real markup can
  be rendered and asserted outside Next, the MiniDonut precedent again. Every
  test names a sentence the reader must actually see.
  VERIFIED FOR REAL, not only by unit test: against a genuinely unopenable
  database all six routes rendered the named state in the browser (200, not
  500, and no console or dev-terminal warnings); against an empty one they
  rendered the missing-table state; and against a genuinely unreachable
  `libsql://` host the real `DriverAdapterError` (HTTP 404 after 2.2 s, no
  `code`, `clientVersion` 7.8.0) classified correctly and produced the
  cloud-mode text byte for byte. The cloud-mode PAGE cannot be loaded locally
  without a login — a `libsql://` URL turns the auth gate on by design
  (`isAuthEnabled()` includes `isCloudMode()`), and forging a session to see it
  is not a thing to build; that last step needs the operator at the keyboard.

- OVERVIEW NAMES EVERY CATEGORY WORTH A SLICE (2026-09-16). The ring drew the
  top three and folded everything else into Other, so on a typical month Other
  was one of the biggest slices on the page while saying nothing about what was
  in it. Overview has no table beside its ring the way /trends does, so the
  ring is the only place a reader learns where the month went.
  THE RULE: every category at 3% or more of the drawable total gets its own
  slice, capped at EIGHT legend rows, the eighth being Other when anything is
  left over. Two edges are deliberate. An Other that would hold ONE category
  names it instead — hiding a single name behind a label buys nothing. And when
  exactly eight categories are everything, the eighth row is a category, not
  an Other of nothing. Other states how many categories it holds IN TEXT
  (`Other · 5`), because the title= tooltip does not exist on a phone.
  /trends KEEPS its top three: the table beside it names every category, so its
  ring only has to show proportion. The two pages share `spendingBreakdown`
  and differ only in the `DonutSlicing` they pass, so shares, arcs and printed
  totals still cannot disagree.
  COLOUR: seven hues for named slices (four existed; `--pie5..7` added in all
  three themes) and a NEUTRAL `--pie-other`, so Other never reads as one more
  category. Arcs and legend swatches come from `ui/donutColors.ts` — a CSS
  variable for the SVG, a literal Tailwind class for the swatch, because
  Tailwind only generates classes it can read in source.
  PERCENTAGES round together (`wholePercents`, the /trends table's
  largest-remainder rounding, moved beside `spendingBreakdown` and now used by
  both): with eight rows, rounding each alone prints legends summing past 100%.
  SPACE: the ring and legend need ~450px side by side, which the right column
  has only at xl, so they sit side by side at xl and stack below it, the legend
  taking the column's width (capped at 380px so figures stay near their names)
  and its name column truncating rather than pushing a figure out. The bigger
  ring came mostly from CROPPING the viewBox to the ring: the old 220x200 box
  spent over a third of its width on padding, so a 200px donut drew a 127px
  ring. MiniDonut draws nothing outside the ring (the hover tooltip belongs to
  /trends' donut), so the crop costs nothing.
  VERIFIED in the dev server at 1280px (side by side, eight rows, no name
  truncated), 1024px (stacked) and 375px (no horizontal scroll, no truncation),
  with computed arc and swatch colours read back in sepia, light and dark:
  eight distinct fills in each, every swatch matching its arc, Other neutral.
  One test in the new block caught a real bug while it was being written: ten
  categories all above 3% drew nine rows, because the all-eligible branch
  capped at eight and then appended Other anyway.

- THE DEMO DATA IS DATED RELATIVE TO TODAY (2026-09-16). `db:seed` pinned
  "today" to a fixed date, so every screen gated to the month being lived in —
  goals, readiness, pace, commitments on /insights, Overview's spending block —
  rendered empty on every day after it was written, which made it useless for
  screenshots and for a public demo. `scripts/demoData.ts` builds the data from
  `now`: 24 complete months plus the current month, deterministic for a given
  moment, all of it invented.
  ONE RULE FOR EVERY FUTURE FEATURE: if a screen can show something the demo
  data cannot trigger, the generator owes it the rows that trigger it —
  otherwise the screenshots and the demo quietly stop showing the feature.
  WHAT LOOKING AT IT TAUGHT, because each was invisible until the pages were
  read on the generated data:
  (a) Fixed days of the month make everyday spending read as SUBSCRIPTIONS —
  groceries and fuel on the same dates came out "biweekly" in Recurring and
  in Already committed. Two days of jitter still read as biweekly for fuel;
  it now lands anywhere in each half of the month.
  (b) The data must END at the newest sync. Rows dated after the last sync
  that could have imported them contradicted the "synced" line on the same
  page. A consequence stated in troubleshooting.md: seeded just after midnight
  UTC on the 1st, the new month is legitimately empty until that night's sync.
  (c) Accounts without snapshots print "history estimated" and a
  reconstructed-balances notice on Overview and /trends; every account gets
  month-end snapshots, as a live feed writes them.
  (d) The one-off and a tagged trip sit in the days just before today, because
  /insights opens on the current month; in the last complete month they were
  one tap away from the screen a visitor lands on.
  (e) readiness.house's savingsFloor is MONTHLY. A first draft set it to a
  fund-sized number and the panel correctly reported no mortgage budget.
  Pinned by scripts/demoData.test.ts across mid-month, both sides of the 1st's
  sync, a year boundary and the day after a leap day, plus a run through the
  real rule pack and insights engine; four deliberate breaks each failed it.
  APP ISSUES THE DEMO SURFACED, recorded in docs/backlog.md rather than fixed
  inside a data change: one large purchase reports twice in the digest (as a
  one-off AND as a category "trending up … /yr if it holds"), and Overview's
  Owed total calls every debt account a "card", loans included.
