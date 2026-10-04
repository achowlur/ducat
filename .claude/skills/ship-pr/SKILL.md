---
name: ship-pr
description: Take a Ducat change from the working tree to a merged and deployed pull request. Covers the branch, the verify gate, what a diff owes (README command row, screenshots or waiver, allowScripts reason), the public-text privacy scan before pushing, gh pr create, auto-fix watching, and checking the deployment after the operator merges. Use whenever committing, pushing, or opening or merging a PR.
---

# Ship a pull request

Read `.claude/rules/publishing.md` first. The repository is PUBLIC, and every
word this procedure writes (commit messages, branch name, PR title and body)
is published.

1. **Branch.** Never commit on main, this session included. The branch name
   is public text: no names, figures or merchants.
2. **Gate every commit** with `/verify` (stage first, read npm test's own exit
   status).
3. **What the diff may owe, in the same commit:**
   - a new `package.json` script: a README command-table row
     (commandTable.test.ts fails otherwise);
   - a pictured screen touched: `npm run screenshots`, or the PR body states
     `screenshots: unchanged — <why>` (CI: scripts/check-screenshots.ts). A
     waiver also answers for the walkthrough;
   - a new dependency with an install script: an `allowScripts` entry by
     NAME, with its reason in the PR;
   - a new convention: one rule line in its tier and its story in
     docs/conventions (CLAUDE.md, "Where instructions live").
4. **Public text.** Diagnose with real data; describe with invented data.
   Check every decimal the branch adds against a backup copy's amounts, so no
   real figure is published. Then commit locally and scan BEFORE pushing,
   since a pushed message cannot be fixed without a force-push:

   ```bash
   BASE_SHA=$(git merge-base main HEAD) HEAD_SHA=HEAD \
   PR_BRANCH="<branch>" PR_TITLE="<title>" PR_BODY="$(cat <body file>)" \
   npx tsx scripts/check-public-text.ts
   ```

   It must print "Public text is clean". It sees commits, the branch and the
   PR text; privacy.test.ts already saw the files.
5. **Push and open:** `git push -u origin <branch>`, then
   `gh pr create --title … --body-file …`.
6. **Watch it.** In the Claude desktop app, bind the PR and turn auto-fix on
   (`set_monitor` with `auto_fix` and `address_comments`) right after
   creating it; the operator merges quickly. Never enable auto-merge unless
   asked. The operator merges, not this session.
7. **After the merge.** Never infer deploy state from the served page or the
   build id: ask the operator to read the Vercel dashboard. Then read back
   every page the change could touch on `<your-deployment>.vercel.app` in the
   in-app browser (`get_page_text` on a logged-in tab), and report what
   rendered. If the session has lapsed, ask the operator to log in; never
   enter credentials, and never fall back to a localhost check.
8. **Say whether DATA or SCHEMA also has to move.** Code ships with git push;
   rows and columns do not. If the change needs `schema:push`, `upgrade` or a
   Setting writer on the cloud, that is the `cloud-data-change` skill, and
   the PR is not finished until it has run.
