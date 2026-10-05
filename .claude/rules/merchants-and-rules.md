---
paths:
  - "src/lib/connectors/**"
  - "src/lib/sync/**"
  - "src/lib/{categories,categoryEdits,p2p}*.ts"
  - "src/lib/ui/merchantLabel*.ts"
  - "src/app/transactions/**"
  - "src/app/categories/**"
  - "src/components/{CategoryPicker,CategoryManager,GroupedReview,P2PSuggestion,AccountTypeSelect}.tsx"
  - "scripts/{audit-rules,install-rule-pack,repair-merchants,repair-text,retarget-rule,simulate-rule-matching,import-csv}.ts"
---

# Rules: merchants & rules

Evidence: docs/conventions/merchants-and-rules.md. Read it before changing
anything below; several entries record "tried and failed, don't retry".

- Grouped-review keys are ≥3 characters — they become priority-50 CONTAINS
  rules that outrank the pack.
- A P2P payment is NEVER categorized unseen: user CATEGORY rules only
  SUGGEST (same payee+amount → payee rule → clear favourite ≥2), only user
  TRANSFER rules auto-apply, and a payee decision confirms its waiting rows
  as MANUAL. Unconfirmed P2P OUTFLOWS are the "P2P — Unreviewed" slice,
  never Uncategorized, and stay out of anomalies and the digest.
- Anything derived from bank text must stay FINDABLE in it: rules.ts
  collapses whitespace on BOTH sides for CONTAINS/EQUALS; payeeKey TRUNCATES
  at the first noise marker, never deletes mid-string.
- Rules only WRITE — deleting one undoes nothing; any rule-removal path
  needs the reapplyRules/TxnRestore snapshot for undo.
- installRulePack keys on matchField|matchOperator|matchValue: never EDIT a
  shipped rule's matchValue — add the new value at the next priority.
- CONTAINS matches at LETTER boundaries: zero leading letters, exactly one
  trailing letter; digits still decorate. A value that stops mid-word needs
  its full form listed BESIDE it plus a rulePack.test.ts entry;
  npm run rules:audit stays at zero.
- Matcher bugs are found by generated probes and the curated corpus —
  transaction volume cannot find them.
- Rule bands: 1-99 user, 200-299 structural, 500-529 brands, 900-999
  generic, 995 payment rail. Card-payment patterns require a card token AND
  a payment token; short brands are word-bounded regexes, never CONTAINS.
- normalizeMerchant truncates at OBSERVED TRANSACTION_TYPE markers only
  (≥3 chars must precede); adding a marker can WIDEN existing rule
  matchValues — measure what the shortened values newly match first.
- ABBREVIATIONS entries must MEASURABLY split a payee. "fid bkg svc llc"
  now meets the bar; if fixed, the instrument is an expansion, not a marker.
- repair:merchants' description-fallback requires: has a marker, shorter,
  AND a prefix of the stored merchant.
- Processor prefixes strip as a PREFIX only; Toast/Slice/DoorDash also
  auto-categorize via DESCRIPTION rules; after normalizer changes,
  repair:merchants must also rewrite MERCHANT rule values.
- inferAccountType order is load-bearing: deposit words → LOAN before
  CREDIT → card words → investment names → card PRODUCT names LAST.
- Categories are made ONLY through lib/categories.ts: whitespace-collapsed,
  40 characters at most, unique in ANY casing (a collision ADOPTS the
  existing row), never a name the app prints for a non-category; NO
  PACK_CATEGORIES name is reserved, or the pack could not install. A new
  category is ASSIGNED by the same write an existing one gets.
- Renamed and deleted ONLY through lib/categoryEdits.ts (server-only: the
  picker imports categories.ts into the browser), and only the operator's
  own: a PACK_CATEGORIES name is fixed, because the pack and the app find
  those by name. A rename never merges. A delete MOVES every row and rule
  first, in one batch: into a category, sources kept and rules retargeted;
  into Uncategorized, rows cleared as "none" clears them and category-only
  rules REMOVED (a rule setting nothing still matches first and shadows the
  pack). Never leave it to the foreign key's SET NULL.
