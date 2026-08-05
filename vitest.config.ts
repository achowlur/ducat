import { defineConfig } from 'vitest/config';

/**
 * The suite is every `*.test.ts` under src/ and scripts/ — and nothing under
 * `.claude/`, which is gitignored local state: agent worktrees live there,
 * each a full copy of the repo. Without this exclusion `npm test` sweeps
 * them too, so the count silently doubles and the verify gate can fail (or
 * pass) on somebody else's half-finished branch rather than on this tree.
 * Measured 2026-08-05: 639 tests became 1281 the moment a worktree existed.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.claude/**'],
  },
});
