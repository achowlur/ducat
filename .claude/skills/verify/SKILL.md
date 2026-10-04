---
name: verify
description: Pre-commit gate for Ducat. Typecheck, lint, tests, and a look at the running app. Run it before every git commit.
---

# Verify

Run every check below and report the result of each. Do not commit anything
if any of them fails; fix it first. A failure is fixed, never committed and
noted.

0. **Stage first: `git add -A`.** privacy.test.ts scans TRACKED files only,
   so a new file that is still untracked when the gate runs is never scanned.
   CI caught that twice.
1. `npx tsc --noEmit`
2. `npm run lint`
3. `npm test`. Read the test command's OWN exit status (`npm test > log 2>&1;
   echo $?`, or `set -o pipefail`). Never pipe it into `grep … && git commit`:
   the pipe's status is grep's, and a failing suite was once committed and
   pushed that way.
4. If the change renders anything (a page, a chart, a number, a layout), open
   the affected page on the already-running dev server and read back the
   actual values or measurements. State what you saw, not that it "should"
   work.

Never run `npm run build` as part of this: the dev server shares `.next/` and
the build corrupts its chunks (see CLAUDE.md).

Exactly one dev server runs at a time. If none is running, start it; do not
start a second one.

After the commit, before any push, the public-text scan in the `ship-pr`
skill runs over the commit message and branch name.
