import { defineConfig } from "vitest/config";

/**
 * The suite is otherwise config-free. Two independent reasons this file exists,
 * added within a day of each other and both load-bearing:
 *
 * 1. WHAT RUNS. The suite is every `*.test.ts` under src/ and scripts/ — and
 *    nothing under `.claude/`, which is gitignored local state: agent worktrees
 *    live there, each a full copy of the repo. Without this exclusion
 *    `npm test` sweeps them too, so the count silently doubles and the verify
 *    gate can fail (or pass) on somebody else's half-finished branch rather
 *    than on this tree. Measured 2026-08-05: 639 tests became 1281 the moment
 *    a worktree existed. The pattern is matched against paths RELATIVE to the
 *    project root, so a worktree still runs its own tests normally when vitest
 *    is invoked from inside it — only a run from the main checkout is pruned.
 *
 * 2. HOW IT COMPILES. tsconfig sets `jsx: "preserve"` (Next.js compiles JSX
 *    itself), so vitest could not import a .tsx component at all — which is why
 *    every test here had been a pure-function test. MiniDonut.test.ts needs the
 *    real server markup, because the bug it pins is only visible in the
 *    emitted string.
 */
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.claude/**"],
  },
});
