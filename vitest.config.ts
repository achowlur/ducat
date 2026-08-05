import { defineConfig } from "vitest/config";

/**
 * The suite is otherwise config-free. This exists for one reason: tsconfig sets
 * `jsx: "preserve"` (Next.js compiles JSX itself), so vitest could not import a
 * .tsx component at all — which is why every test here had been a pure-function
 * test. MiniDonut.test.ts needs the real server markup, because the bug it pins
 * is only visible in the emitted string.
 */
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
});
