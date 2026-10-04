---
name: perf-measure
description: Measure Ducat page or query speed, or back any timing claim ("faster", "N ms", "this removes a round trip"). Covers measuring on the cloud deployment, ABBA counterbalancing with identical query lists, reading /api/diag/timing (cold samples, normalisation), and DOM size as page cost.
---

# Measure performance

Read `.claude/rules/performance.md` first, then docs/conventions/performance.md
(its "Reading /api/diag/timing correctly" and "MEASURE TIME ON THE CLOUD"
entries) before quoting any number.

1. **Where.** MEASURE TIME ON THE CLOUD, structure on localhost:
   `preview_start` prod, never `npm run dev`, for any measurement. Localhost
   has no network, so it cannot show round-trip cost, which is the cost on
   Turso.
2. **Design.** Timing claims need counterbalanced ABBA designs running
   IDENTICAL query lists on both arms.
3. **/api/diag/timing:** discard cold samples (msSinceFunctionBoot < ~2000),
   normalize against the trivial queries in the SAME response, and
   sequential.rows is a connection-setup artifact. A healthy `connectMs`
   proves the server is reachable, nothing more.
4. **What to count.** Round trips, not bytes: Promise.all buys ~1.13x, and a
   relation include is one statement each. Page cost is DOM SIZE (parse and
   hydration), not bytes on the wire.
5. **Report** the median of each arm, the sample count, and the design, so
   the claim can be re-run.
