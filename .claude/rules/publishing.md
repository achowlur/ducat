---
paths:
  - "**/*.test.ts"
  - "src/lib/demo/**"
  - "docs/**"
  - "README.md"
  - "DEPLOY.md"
  - "CLAUDE.md"
  - "public/**"
  - ".claude/**"
  - ".github/**"
  - "scripts/{privacyScan,check-public-text,screenshotSync,check-screenshots,capture-screenshots,seed,readmeArt}.ts"
---

# Rules: publishing (the repository is PUBLIC)

Evidence: docs/conventions/publishing.md. Read it before changing anything
below. Committing, pushing or opening a PR: the `ship-pr` skill.

- NOTHING PUBLIC carries personal data: tracked files, commit messages and
  identities, branch names, PR titles and descriptions, GitHub comments,
  and the repository's About fields (website, description, topics, social
  preview).
  Figures present at publication are scaled by a DESTROYED constant; a NEW
  figure is INVENTED, never read from real data. People fictional, card
  digits 1234, codes synthetic, account names generic, account digits 000N,
  no live deployment URL (the ONE exception is the public demo,
  ducat-demo.vercel.app, named exactly in privacyScan.ts), no real email. privacy.test.ts (files) and
  check-public-text.ts in CI (commits, branch, PR text) catch SHAPES only;
  amounts, names, merchants and addresses rest on discipline, and nothing
  checks GitHub comments or the About fields.
- README images come ONLY from `npm run screenshots` (invented demo data, a
  throwaway database, its own `.next-capture/` build); a PR touching a pictured
  screen retakes them or states `screenshots: unchanged — <why>`, which CI
  enforces (scripts/screenshotSync.ts). The check never sees the WALKTHROUGH,
  which holds on every Trends card, so a waiver answers for it too. Run
  privacyScan over new PR text and commit messages BEFORE pushing — a pushed
  message cannot be fixed without a force-push.
- A screen feature the demo cannot show owes the generator
  (src/lib/demo/data.ts) the rows that show it (evidence:
  docs/conventions/ui-and-pages.md).
