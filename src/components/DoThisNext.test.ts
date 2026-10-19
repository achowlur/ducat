import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NextAction, Nudge } from "../lib/ui/nextAction";

vi.mock("../app/actions", () => ({ markNudgeDone: vi.fn() }));
const { DoThisNext } = await import("./DoThisNext");

const nudge = (over: Partial<Nudge>): Nudge => ({
  key: "idle-cash",
  kind: "idle",
  text: "$46,000 in Everyday Checking ...0001 earns nothing past a month of spending",
  short: "idle cash",
  href: "/insights#net-worth-goal",
  asOf: 0,
  order: 0,
  ...over,
});
const render = (next: NextAction, checked = true) => renderToStaticMarkup(createElement(DoThisNext, { next, checked }));

describe("DoThisNext", () => {
  it("is PRESENT with a nudge: the lead alert, its Then line, Details and Mark done", () => {
    const html = render({
      lead: nudge({}),
      then: [nudge({ key: "p2p", short: "1 P2P to confirm" }), nudge({ key: "stale", short: "Chase behind" })],
      waiting: 0,
    });
    expect(html).toContain("Do this next");
    expect(html).toContain("$46,000 in Everyday Checking ...0001 earns nothing past a month of spending");
    expect(html).toContain("Then: 1 P2P to confirm · Chase behind");
    expect(html).toContain('href="/insights#net-worth-goal"');
    expect(html).toContain("Details");
    expect(html).toContain("Mark done");
    expect(html).toContain("tap44");
  });

  it("is PRESENT with nothing to do, and STATES all clear in quiet text, not an alert", () => {
    const html = render({ lead: null, then: [], waiting: 0 });
    expect(html).toContain("Do this next");
    expect(html).toContain("All clear.");
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("Mark done");
  });

  it("says how many marked done wait for newer data", () => {
    expect(render({ lead: null, then: [], waiting: 2 })).toContain("2 marked done wait for newer data");
  });

  it("says nothing is checked yet before the first sync, never all clear", () => {
    const html = render({ lead: null, then: [], waiting: 0 }, false);
    expect(html).toContain("Nothing to check until the first sync.");
    expect(html).not.toContain("All clear");
  });
});
