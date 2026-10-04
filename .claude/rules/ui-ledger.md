---
paths:
  - "src/app/transactions/**"
  - "src/components/{CategoryPicker,GroupedReview,ReimburseControl,GroupPicker,RenameGroup,AccountFilter,P2PSuggestion}.tsx"
  - "src/lib/ui/{flowFilter,periodSpan,categoryFilter,accountFilter,groupFilter,ledgerTotals,repaid,reimburseCandidates,merchantLabel,trips}*.ts"
---

# Rules: the ledger (/transactions)

Evidence: docs/conventions/ui-and-pages.md. Read it before changing anything
below. The rules for every rendered surface (phone width, dates, em dash,
headings, uncertainty) are in CLAUDE.md; page-wide ones in ui-reports.md.

- /transactions PAGINATES — capping without paging is a data-visibility
  bug; every filter-changing link resets page.
- /transactions prints TWO TOTALS of its filtered list (ui/ledgerTotals.ts),
  every page above and this page below: OUT, IN, NET, transfers as two
  figures never in the net, and REPAID, the linked repayments of listed
  bills that the list does not show (ui/repaid.ts), netted so a category
  view's net IS /trends' figure (repaid.test.ts pins it).
- ?flow= is read only by ui/flowFilter.ts. SPENDING and INCOME are the two
  FIGURES, decided by isReimbursement itself (never a second definition) and
  finished in memory; a repayment linked to an outflow is never listed under
  SPENDING, it arrives as REPAID. EVERY link from a printed spending or income
  figure names its measure, so the band adds up to the figure to the cent
  (report.test.ts walks every Trends link).
- ?period= is ONE period key or a span of whole months `A..B`, read only by
  ui/periodSpan.ts; a span gets the select's synthetic entry and no month
  step. ?merchant= is EXACT by merchantKey: SQL narrows to a SUPERSET (pinned
  by merchantLabel.test.ts) and the list finishes in memory, like review mode.
- ?category= is an INCLUSION list, written/read ONLY by
  ui/categoryFilter.ts; null means the Uncategorized bucket and
  `p2p-unreviewed` the DISJOINT P2P one (split in memory by nullBucketFilter);
  the multi-id group lives in where.AND; the select needs its synthetic entries.
- ?group= is the trip filter, owned by ui/groupFilter.ts (the payee queue
  is ?payees=1); the group is a scalar equality beside q's OR and the
  category AND; the totals band and the /insights TRIPS rows sum EXACTLY
  what their own filtered view shows — transfers included when tagged,
  and the wording says so; no group touching a period means the section
  is ABSENT, never empty; an untagged row's picker starts with NOTHING
  active, so bare Enter writes nothing; RENAME (the band's control) rewrites
  the WHOLE group, never the filtered view, and renaming onto an existing
  label MERGES — warned before saving, because a merge does not undo by
  renaming back; casing adoption is enforced server-side.
- ?account= is an INCLUSION list, written/read ONLY by ui/accountFilter.ts;
  one id is a list of one, a repeated key is read whole and re-encoded as
  ONE value, and the checkbox control stages its ticks until submit.
- A bill with linked repayments says so ON ITS ROW, at every width: what
  came back and the share left.
- The ledger's category control is ONE picker in a PORTAL; drive the real
  page after any change to it, and LOOK at a portal's pixels, not only the
  DOM: an anchor rect is measured ONCE at open (a detached anchor measures
  zero and floors the popover into the corner). GroupedReview keeps its
  <select> deliberately.
- EVERY ledger popover owes ESCAPE, CLICK-OUTSIDE and FOCUS RESTORE:
  click-outside is what makes "only one open at a time" free, and without it
  a second panel stacks over the first. Below md a control at the row's right
  edge opens its panel LEFTWARD, or most of it hangs off the horizontal
  scroller.
- A popover that closes on PAGE scroll excludes its OWN list from that
  capture listener and carries `overscroll-contain`. Test pickers at 720px
  of height, on a row whose category sits LOW in the list.
- The category picker OFFERS a typed name matching no category as a new
  one, twice (spending, income), LAST, and never active: bare Enter
  creates nothing.
- A refused write is said BESIDE its control in the action's own words; the
  portal pickers say it on the ROW (`RowRefusal`), on its own line capped at
  220px at EVERY width (uncapped, it reflowed the table). A client never
  prints `e.message`; the unexpected reads `ACTION_DID_NOT_COMPLETE`
  (evidence: security-and-auth.md, REFUSALS ARE VALUES).
