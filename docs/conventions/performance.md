# Ducat — performance conventions

> Every figure in this file is scaled by one unrecorded constant: ratios are exact, no absolute value is real. See [publishing.md](publishing.md).

Moved VERBATIM from CLAUDE.md on 2026-08-01 (the split). This file holds the
full evidence — what each rule cost and why alternatives failed. The one-line
enforceable rules live in CLAUDE.md and point here. Additions follow the same
contract: rule line in CLAUDE.md, evidence here, never both in one place.

- In cloud mode a Turso round trip costs ~6ms WARM and 17-58ms while the
  instance is still warming. The "20-25ms MINIMUM" previously recorded here was
  a warming number read as a floor: the zero-row query written down at 34.8ms
  and the 8-row one at 24.7ms both measure ~6ms once hot, because a cold
  invocation inflates EVERY query 3-10x together. Neither number is "the" cost
  and both matter — Hobby has no provisioned concurrency, so real page views
  land on lukewarm instances often and pay the higher one, while anything you
  measure back-to-back pays the lower. What survives unchanged is the
  conclusion: what matters is the NUMBER of round trips, not the size of any of
  them. Cold start is a separate and larger cost again: ~600-800ms of client
  init and TLS lands on whichever query runs first.
- The `Promise.all` on `/transactions` buys about 1.13x, NOT the "six
  concurrent trips cost about the slowest one rather than their sum" this file
  used to claim — that would be nearer 4x. Measured with the ABBA arrangement
  in `/api/diag/timing` (`ordering.concurrentSpeedup`) across seven warm
  samples: 1.63, 1.25, 1.20, 1.15, 0.95, 0.88, 0.87 — mean 1.13, median 1.15,
  individual samples on BOTH sides of 1. libSQL over HTTP overlaps round trips
  only weakly, so concurrency is worth keeping (it is never meaningfully worse)
  while being nowhere near free parallelism. Consequences: a query that GATES
  the others costs about its own round trip, not the loss of parallelism, so
  the old "never add one" is too strong — prefer a filter default that needs no
  database read, but do not contort the page to avoid a gate. And do not try to
  buy speed by adding concurrency; buy it by removing round trips, which is
  what the `include` work above actually did.
- Two things this measurement cost, both worth avoiding again. The endpoint
  compared UNLIKE things for a while: a `replace_all` matched only one of two
  identically-shaped copies of the rows query, so the concurrent group kept an
  `include` the sequential one had dropped — 9 statements against 7 — and every
  number it produced argued for a conclusion that was purely the extra round
  trips. The six queries are now defined ONCE and both arrangements run that
  list, which makes the divergence impossible rather than unlikely. And the
  design was too weak before it was counterbalanced: sequential-then-concurrent
  cannot separate "concurrent is slower" from "whatever runs second is slower",
  and the A-blocks really do differ by position (124.5ms at position 1 against
  66.3ms at position 4 in one sample). ABBA is why the number is trustworthy.
- Reading `/api/diag/timing` correctly, because it is easy to read three
  different numbers off it and believe all of them. `msSinceFunctionBoot` under
  ~2000 means that sample paid a cold start — discard it, or read it as the
  ceiling. Take several samples: absolute ms drift 2x between batches on
  identical code, so normalize the query you care about against the trivial ones
  in the SAME response (`accounts`/`dateRange`/`reviewPool`) rather than
  comparing raw ms across readings. And its `sequential.rows` entry is an
  ARTIFACT, not a query cost — the first database call of a request absorbs
  connection setup. The proof is arithmetic: one response reported `rows` at
  194.1ms and `parallelGroupMs` at 72.7ms, and the parallel group RUNS THAT SAME
  QUERY, so 194.1ms cannot be its intrinsic cost. `sequentialTotalMs` inherits
  the error and is not a real "if these were serialized" figure.
- A relation `include` is a ROUND TRIP — one SQL statement each, confirmed by
  counting Prisma's query log. So `include: { a: true, b: true, c: true }` is
  four statements, and on Turso that is four round trips. Both of
  `/transactions`' big queries were fixed by selecting columns instead:
  - The reimbursement candidate pool (the only query that cannot join the
    `Promise.all`, since its date window comes from the rows already fetched)
    went 41.2ms → ~19ms warm, 5.9x the trivial-query cost down to 2.7x.
  - The row list went from 4 statements to 2 and 32-47ms → 16-24ms warm,
    5.1-7.7x down to 2.5x. `category` was already dead once the category picker
    started taking `categoryId` instead of the object; `account` supplied one
    NAME that the `accounts` array already has. `reimburses` STAYS — it points
    at another transaction, so nothing in memory can answer it.
  Normalize against the trivial queries in the same response when judging any
  of this; raw ms drift 2x between batches.
- MEASURE TIME ON THE CLOUD, structure on localhost. Localhost has no network,
  no cold start, a `file:` database instead of HTTP round trips to Turso, and a
  desktop CPU instead of a phone — so every TIME number it gives is fiction, and
  three wrong diagnoses in one session came from trusting one. What localhost
  measures correctly is STRUCTURE, which is identical everywhere: DOM node
  counts, how many queries a page issues, uncompressed payload composition,
  whether something is accidentally quadratic. Use `preview_start prod` for
  those (never `npm run dev` — its React SSR reported 870 ms for a page
  production serves in 87 ms). For time, read the deployed app: DevTools →
  Network → Timing gives TTFB and Content Download, and the numbers that matter
  are TTFB (server + round trips) and whatever happens after it (hydration).
- Page cost on this app is DOM SIZE, not server time and not bytes on the wire.
  `/transactions` built a 1.1 MB document (952 KB of markup across 300 rows,
  3705 `<option>` elements because every row renders the whole category list)
  against 30-57 KB for every other page. A page is now 402 KB / 1161 options.
  Three wrong diagnoses preceded the right one, all from measuring the wrong
  thing — worth not repeating: (1) the reimbursement hot path (74 inflows × 470
  outflows) is 2.5 ms, so hoisting its projection would have saved 0.6 ms;
  (2) `npm run dev` reported 870 ms for a page production serves in 87 ms, so
  measure with `preview_start prod`, never dev; (3) the document size is NOT a
  transfer cost — Vercel serves `Content-Encoding: br`, and repeated markup is
  what Brotli is best at (292 KB of identical selects compresses 1249× to
  0.2 KB). What a big document actually costs is parse, DOM construction and
  React hydration on the client's CPU, which is why cutting ROWS helped and
  why compressing harder would not have.
- Analyzer cost is BUCKETING, not arithmetic, and `generateInsights` runs
  synchronously inside server actions — so analyzer time is a hang on a
  dropdown. Period bounds are memoized (`periods.ts`), and anomaly history is
  bucketed once per period with each bucket's median/MAD computed once
  (`anomalies.ts`). Re-deriving either per transaction is what made 10,000
  transactions cost 4.1s instead of 0.15s. Both caches are safe because their
  keys are immutable and both statistics sort, so order in a bucket is
  irrelevant.
- Reimbursement candidates travel ON OPEN (2026-08-02). The backlog's
  "/transactions is 10× slower" entry resolved in two unequal halves. The
  compute half (candidatePool.map inside candidatesFor) was already dead —
  the 2026-07-27 commit “Stop joining categories into the reimbursement pool” hoisted it, and the hot path measures 2.5 ms. The serialization
  half was the live bug: on a production build against 2,677 rows,
  ?flow=INFLOW embedded 1047 candidate objects for 99 pickers nobody had
  opened. Candidates now arrive via the suggestCandidates server action
  (3 statements, paid only on open) and a row ships only its strong-match
  hint: 446→375 KB (−16%), zero embedded candidates, loads still 9
  statements, DOM unchanged at ~1,735 — proof again that the payload, not
  the element count, was carrying the weight. The identity guarantee is
  structural, not hopeful: page and action project through
  makeCandidateFinder, and the action's narrow window returns exactly what
  the page's shared pool returns because suggestReimbursements HARD-EXCLUDES
  candidates outside [inflow − 45d, +3d] before amount evidence can rank
  them, and filtering preserves order — reimburseCandidates.test.ts pins the
  equivalence, order and wording, and an adversarial replay against every
  unlinked inflow measured 214/214 byte-identical. Two bounds the identity
  carries, added by that review: it holds only while a page's pool span
  stays under REIMBURSE_POOL_TAKE (2000; largest observed 281), and both
  pool queries order date desc THEN id desc so same-date SQL ties cannot
  resolve differently between the wide and narrow forms.
