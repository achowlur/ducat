# Ducat — publishing conventions

Added 2026-09-16, the day the repository went public. This file holds the
full evidence — what each rule costs and why the alternatives were rejected.
The one-line enforceable rules live in CLAUDE.md and point here. Additions
follow the same contract: rule line in CLAUDE.md, evidence here, never both
in one place. This file is itself bound by the rule it documents: it carries
no dollar amount, count, percentage, ratio, digest or hash anywhere below.

- NO REAL FIGURES, ANYWHERE IN THE PUBLISHED TEXT (2026-09-16, publication).
  From this date, every dollar amount and every count that appears in docs,
  comments, tests and commit messages is scaled by ONE unrecorded constant,
  drawn once and never written down anywhere in the repository — not in a
  script, not in a config file, not in a comment explaining that scaling
  happened. It cannot be recovered from the published text, which is the
  point: a constant recorded beside the figures it protects protects
  nothing. Because the constant is single and uniform, every RATIO and
  RELATIONSHIP between figures in a worked example survives exactly, while
  no individual absolute value is the real one — a share-of-total stays the
  same share, a period-over-period change stays the same multiple. That
  property is what keeps the evidence files readable as evidence:
  docs/conventions/sync-and-data-ops.md tells a story about a database
  fingerprint changing while a row count did not, and that story needs the
  before/after counts to actually agree with each other, or it stops proving
  what it exists to prove.
  Two alternatives were rejected in reasoning before either was tried.
  Redacting figures outright was rejected because the worked examples ARE
  the evidence files' content — a story built on a specific rule, a specific
  count, a specific digest pair carries information a blanked-out figure
  erases along with it, and these files exist so a reader does not have to
  take the rule's word for it. Hand-inventing replacement figures was
  rejected for the opposite reason: the moment two related numbers in the
  same story must agree with each other — a total and the share computed
  from it, a "same count, different digest" claim — invented figures either
  need the original arithmetic redone by hand to stay consistent, or they
  quietly stop agreeing, and a reader who checks the math loses trust in
  every other number in the file. A single scaling constant gets that
  consistency for free, because it was already there in the original.
  The mechanical guard, scripts/privacy.test.ts, catches what has a SHAPE:
  card digits, reference and trace codes, masked-account patterns, email
  addresses, live hostnames, and gmail addresses in particular, each
  recognizable by pattern independent of context. It cannot tell a scaled
  dollar figure or a scaled row count from a real one — a plausible-looking
  amount is not intrinsically fictional — so money and counts rest on
  discipline AT THE POINT OF WRITING, not on anything the suite enforces
  afterward. Naming that gap is the point: the test is a floor under the
  mechanical cases, not a substitute for scaling a figure before it is typed.
- THE PR GATE, ADDED AT PUBLICATION, NOT BEFORE (2026-09-16). Before the
  repository went public, the only gate a change had to pass was the local
  pre-commit /verify — typecheck, lint, tests, a look at the running app —
  run by hand on one machine, configured by hand over months of sessions.
  That gate is real and stays; publication does not weaken it. But it proves
  only that a change works on that particular machine, set up that
  particular way. A public repository needs proof that a change stands up on
  a machine nobody hand-configured at all, which is what a clean-checkout
  `npm ci` on a fresh CI runner establishes and a local run cannot. So from
  2026-09-16, every change lands on a branch and merges only through a pull
  request gated on a green `verify` check in that clean environment — never
  a direct commit to main — and this binds Claude Code's own sessions
  exactly as it binds anyone else's. There is no exemption for a change that
  "just" touches docs or scripts: docs/conventions/sync-and-data-ops.md
  and docs/history.md both record documentation and tooling drifting out of
  sync with the codebase precisely because such changes felt too small to
  need a second look.
  The two gates are complementary, not redundant. CI cannot do what the
  local gate's last step does — load the affected page in the running dev
  server and read back actual behavior — because CI has no running app to
  read from; that check stays local and stays required. What CI adds is the
  thing months of accumulated local state can hide from the person who
  accumulated it: an undeclared dependency, a script that only works because
  some stray file already exists on that one machine. Publication is what
  made that failure mode matter — before it, the only person who would ever
  clone the repository fresh was the same person, on the same machine.
