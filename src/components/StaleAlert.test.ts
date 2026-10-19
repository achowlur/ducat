import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaleAlert } from "./StaleAlert";

const acct = { name: "Riverstone Rewards Visa", connectorType: "SIMPLEFIN", balanceLagDays: 6, behind: true };
const render = (accounts: (typeof acct)[]) => renderToStaticMarkup(createElement(StaleAlert, { accounts }));

describe("StaleAlert", () => {
  it("is PRESENT for a stale SimpleFIN account, with a Reconnect link to the hosted flow", () => {
    const html = render([acct]);
    expect(html).toContain("Stale");
    expect(html).toContain("Riverstone Rewards Visa is 6 days behind");
    expect(html).toContain('href="https://bridge.simplefin.org"');
    expect(html).toContain("Reconnect");
    expect(html).toContain("tap44");
  });

  it("renders nothing for a statement-only account", () => {
    expect(render([{ ...acct, connectorType: "PDF" }])).toBe("");
  });
});
