import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { assessGoals, type SavingsGoal } from "../../lib/insights/goals";
import { SavingsGoalCard } from "./SavingsGoalCard";

// The card imports the server action; the render needs none of it.
vi.mock("../../app/insights/actions", () => ({ saveSavingsGoalPace: vi.fn() }));

/** Assertions are on what is PRESENT (CLAUDE.md): an alert that never rendered must fail, not pass. */
const NOW = new Date(Date.UTC(2026, 6, 31, 12, 0, 0));
const NETS = [2000, 1000, 3000, 2000, 1000, 3000]; // 2,000 a month, invented

const render = (over: Partial<SavingsGoal>, nets = NETS) => {
  const [g] = assessGoals({
    goals: [{ id: "house-deposit", name: "House deposit", target: 60_000, targetMonth: "2027-06", accountIds: ["sav"], ...over }],
    accounts: [{ id: "sav", name: "Savings", balance: 24_000 }],
    completeMonthlyNet: nets,
    now: NOW,
  });
  return renderToStaticMarkup(createElement(SavingsGoalCard, { g, history: [], anchor: "2026-07", window: null }));
};

describe("SavingsGoalCard's BEHIND alert", () => {
  it("is present when the goal lands after its target month, with the figure, the detail and the field", () => {
    const html = render({});
    expect(html).toContain('role="status"');
    expect(html).toContain("Behind");
    expect(html).toMatch(/Save ~\$1,\d{3}\/mo more to land on time/);
    expect(html).toContain("House deposit, target June 2027");
    expect(html).toContain('id="savings-pace-house-deposit"');
    // Pre-filled with the measured 2,000 plus the extra, so the shortfall lands on time.
    const value = /id="savings-pace-house-deposit"[^>]*value="([\d,]+)"|value="([\d,]+)"[^>]*id="savings-pace-house-deposit"/.exec(html);
    const typed = Number((value?.[1] ?? value?.[2] ?? "").replace(/,/g, ""));
    expect(typed).toBeGreaterThan(3000);
  });

  it("is absent when on track, and the field stays in the controls", () => {
    const html = render({ targetMonth: "2028-01" });
    expect(html).not.toContain("Save ~");
    expect(html).not.toContain('role="status"');
    expect(html).toContain("Saved per month");
    expect(html).toContain('id="savings-pace-house-deposit"');
    expect(html).toContain("6-month average");
  });

  it("is absent when ahead, and without a target date", () => {
    expect(render({ targetMonth: "2030-01" })).not.toContain("Save ~");
    const open = render({ targetMonth: undefined });
    expect(open).not.toContain("Save ~");
    expect(open).toContain("Saved per month");
  });

  it("is absent with no pace, which says so instead", () => {
    const html = render({}, [-500, -500, -500, -500, -500, -500]);
    expect(html).not.toContain("Save ~");
    expect(html).toContain("you are not saving");
  });

  it("names a pace the operator set, and offers the measured one back", () => {
    const html = render({ monthlyPace: 4000 });
    expect(html).toContain("Assumed");
    expect(html).toContain("Use usual, ");
    expect(html).not.toContain("Save ~"); // 4,000 a month lands on time
  });

  it("carries no em dash in what it prints", () => {
    expect(render({})).not.toContain("—");
  });
});
