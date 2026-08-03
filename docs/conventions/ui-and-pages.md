# Ducat — UI & page conventions

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
  `overflow-x` container clips the other axis too. Four bugs in it were
  invisible in source and only appeared by driving the real page, so drive it
  after any change: (1) `disabled` cannot hold focus, so disabling the trigger
  during the write blurred to `<body>` and lost your place after every
  categorization — it uses `aria-disabled` plus handler guards; (2) a popover
  that assumes its own height runs off the screen (a 579px list, 275px down an
  800px viewport), so it measures the room and caps `maxHeight`; (3)
  `mouseenter` fires when a popover appears under a STATIONARY cursor, handing
  the keyboard whichever option the mouse sat on — `mousemove` does not;
  (4) the active option starts on the row's CURRENT category and, when
  searching, on the first PREFIX match, because substring search is better than
  native type-ahead ("housing" finds "Rent & Housing") but must not lose it
  ("g" has to mean Gas, not Dining). `GroupedReview` deliberately keeps its
  `<select>`: its choice is STAGED before a write that can rewrite dozens of
  rows, which is a different contract, and it is not on the hot path.
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
