---
name: worktree-agents
description: Run parallel agents on Ducat in git worktrees. Covers the setup a worktree does not inherit (.env, data, node_modules junction, prisma generate, a port of its own), keeping agents off the real database, and the teardown order that protects the main checkout's node_modules.
---

# Parallel agents in git worktrees

A worktree starts bare: `.env`, `data/` and most of `.claude/` are gitignored,
and `node_modules` is absent. Each agent needs, in its own worktree (on
Windows, PowerShell):

1. Copy `.env` and `data/` from the main checkout. `DATABASE_URL` is
   relative, so the agent hits its own disposable copy. The real database is
   never touched by an agent experiment.
2. Junction `node_modules`:
   `New-Item -ItemType Junction -Path node_modules -Target <main>\node_modules`.
3. `npx prisma generate`, since the client output `src/generated/prisma` is
   gitignored.
4. Serve on its own port, 3101 and up:
   `npx next dev -H 127.0.0.1 -p <port>`. One port or one database shared by
   several agents collides.

The repo `.env` holds no Turso credentials, so an agent cannot write to the
cloud. Cloud steps stay with the operator (`cloud-data-change`).

`npm test` and `npm run lint` from the MAIN checkout already exclude
`.claude/**`, so a worktree under `.claude/worktrees/` does not double the
suite or fail lint.

Teardown, in this order:
1. `cmd /c rmdir <worktree>\node_modules` removes the junction ONLY. A
   recursive delete that follows the junction eats the real `node_modules`.
2. Then `git worktree remove <worktree>`.
