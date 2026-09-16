import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNoReplyIdentity, scanText } from "./privacyScan";

/**
 * Guards the boundary this repo crosses once: private instance -> public
 * source. It reads every TRACKED text file and looks for the shapes a real
 * statement export or a real account leaves behind (see privacyScan.ts).
 * Commit messages, commit identities, the branch name and pull request text
 * are published too but never land in a file; check-public-text.ts covers
 * those in CI with the same rules.
 *
 * Every hit is collected into ONE assertion. A leak like this is a
 * repo-wide property, not a single line: reporting only the first would
 * mean fixing one file, rerunning, and finding the next one by hand, over
 * and over.
 */

const root = join(import.meta.dirname, "..");

const SKIP_FILES = new Set(["package-lock.json"]);

const BINARY_EXTENSIONS = new Set([
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".zip",
  ".db",
  ".sqlite",
  ".mp4",
]);

function trackedTextFiles(): string[] {
  const out = execSync("git ls-files", { cwd: root, encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .filter((path) => path.length > 0)
    .filter((path) => !SKIP_FILES.has(path))
    .filter((path) => !BINARY_EXTENSIONS.has(extname(path).toLowerCase()));
}

describe("privacy", () => {
  it("ships no real card digits, rail reference codes, account masks, personal email, live cloud hostname, or mail provider", () => {
    const violations: string[] = [];

    for (const path of trackedTextFiles()) {
      let contents: string;
      try {
        contents = readFileSync(join(root, path), "utf8");
      } catch {
        continue; // not readable as UTF-8 text — nothing this test can check
      }
      violations.push(...scanText(path, contents));
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});

// The violating inputs below are assembled at run time, never written as a
// literal: this file is itself a tracked file the test above scans.
describe("public text scanner", () => {
  const fakeDigits = "55" + "55";
  const cardMarker = ["CARD", fakeDigits].join(" ");
  const personalAddress = "someone" + "@" + "gm" + "ail.com";

  it("passes an ordinary commit message with its co-author trailer", () => {
    const message = [
      "Move the CI actions off the retiring runtime",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
    ].join("\n");
    expect(scanText("commit message", message)).toEqual([]);
  });

  it("names the line of a card marker in a pull request description", () => {
    const body = ["Fixes the ledger.", `Seen on ${cardMarker} last week.`].join("\n");
    expect(scanText("pull request description", body)).toEqual([
      `pull request description:2 — CARD marker with non-synthetic digits (${fakeDigits})`,
    ]);
  });

  it("flags a personal address in a commit message", () => {
    const found = scanText("commit message", `Reported by ${personalAddress}`);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((line) => line.startsWith("commit message:1 — "))).toBe(true);
  });

  it("accepts only no-reply commit identities", () => {
    expect(isNoReplyIdentity("12345+someone@users.noreply.github.com")).toBe(true);
    expect(isNoReplyIdentity("noreply@github.com")).toBe(true);
    expect(isNoReplyIdentity(personalAddress)).toBe(false);
    expect(isNoReplyIdentity("noreply@anthropic.com")).toBe(false);
  });
});
