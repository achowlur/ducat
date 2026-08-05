import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MiniDonut } from "./MiniDonut";
import type { DonutSliceData } from "../lib/ui/spendingBreakdown";

const SLICES: DonutSliceData[] = [
  { label: "Dining", categoryIds: ["cat-dining"], value: 412.5, share: 0.569 },
  { label: "Other", categoryIds: ["cat-a", null], value: 31.2, share: 0.043 },
];

/**
 * The SERVER RENDER is the only place this bug was visible. React serializes a
 * <title> from `children` only when that is a single string; give it two and it
 * emits `<title></title>` — silently, in place — while the client renders the
 * text. The mismatch fails hydration for the whole document, and React's
 * recovery re-renders from <html> down, dropping the data-theme that the
 * pre-paint script in layout.tsx had stamped there. Overview was the only page
 * drawing a donut, so Overview was the only page that ignored a saved
 * light/dark theme.
 *
 * Neither the source nor the hydrated DOM shows it — the JSX reads as one
 * string and the client tree is correct — so the assertion has to be on markup.
 * createElement rather than JSX because vitest runs with tsconfig's
 * `jsx: preserve` and the suite carries no vitest config to override it.
 */
describe("MiniDonut server markup", () => {
  it("puts the slice tooltip text inside <title>, not an empty tag", () => {
    const html = renderToStaticMarkup(
      createElement(MiniDonut, { slices: SLICES, centerTop: "$724", centerBottom: "Aug" }),
    );
    expect(html).not.toContain("<title></title>");
    expect(html).toContain("<title>Dining: 56.9%</title>");
  });

  it("keeps one string child when hrefFor appends the link hint", () => {
    const html = renderToStaticMarkup(
      createElement(MiniDonut, {
        slices: SLICES,
        centerTop: "$724",
        centerBottom: "Aug",
        hrefFor: (s: DonutSliceData) => `/transactions?category=${s.categoryIds[0] ?? ""}`,
      }),
    );
    expect(html).not.toContain("<title></title>");
    expect(html).toContain("<title>Dining: 56.9% — view transactions</title>");
  });
});
