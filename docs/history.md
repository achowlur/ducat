# Ducat — build history

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

