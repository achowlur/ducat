import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * README's command table has to list every script an operator runs.
 *
 * Written because the table has drifted TWICE — repaired 2026-08-01, wrong
 * again by 2026-08-05 — and the mechanism is not neglect. Four of the six
 * commands missing that second time had been ADDED in the two days after the
 * docs were written, so the table drifts by SHIPPING. A convention line asking
 * people to remember is the thing that already failed; this fails the build
 * instead, on the commit that adds the script, while the author still knows
 * what it does.
 *
 * INTERNAL is the deliberate exception list, and every entry owes a reason —
 * an unexplained entry here is just the drift again, one level down.
 */
const INTERNAL: Record<string, string> = {
  postinstall: "an npm lifecycle hook (prisma generate); it runs inside npm install and nobody types it",
  lint: "bare eslint — part of the pre-commit gate in CLAUDE.md, not something a user of the app runs",
  "turso:baseline":
    "emits baseline SQL to stdout and touches no database; a sub-step of turso:push, documented in DEPLOY.md",
  build:
    "covered in prose under 'Measuring performance', where the never-build-while-dev-runs hazard travels with it — a bare row would strip the warning off the one command that corrupts .next/",
  start: "same prose; it only means anything paired with build, for measuring against a production build",
};

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const readme = readFileSync(join(root, "README.md"), "utf8");

/** Only table ROWS count. A mention in prose is not an index entry. */
function listedInTable(script: string): boolean {
  const command = script === "test" ? "npm test" : `npm run ${script}`;
  return readme.split(/\r?\n/).some((line) => line.startsWith(`| \`${command}\``));
}

describe("README command table", () => {
  it("has a row for every operator-facing package.json script", () => {
    const undocumented = Object.keys(pkg.scripts).filter(
      (script) => INTERNAL[script] === undefined && !listedInTable(script),
    );
    expect(undocumented, `add a row to README's command table for: ${undocumented.join(", ")}`).toEqual(
      [],
    );
  });

  it("lists no command that package.json no longer has", () => {
    const rows = readme
      .split(/\r?\n/)
      .filter((line) => line.startsWith("| `npm "))
      .map((line) => /^\| `npm (?:run )?([\w:-]+)`/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    const orphaned = rows.filter((name) => pkg.scripts[name] === undefined);
    expect(orphaned, `README documents commands that do not exist: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("keeps the internal exception list honest — every entry still exists and stays unlisted", () => {
    for (const [script, reason] of Object.entries(INTERNAL)) {
      expect(pkg.scripts[script], `INTERNAL names ${script}, which package.json no longer has`).toBeDefined();
      expect(reason.length).toBeGreaterThan(20);
      // Without this the test only proved the exemptions EXIST, never that they
      // are still exemptions — a row added for `build` would have passed all
      // three tests while the recorded reason said it must not be listed.
      expect(
        listedInTable(script),
        `INTERNAL exempts ${script}, but README's table now has a row for it — drop the row or drop the exemption (${reason})`,
      ).toBe(false);
    }
  });
});
