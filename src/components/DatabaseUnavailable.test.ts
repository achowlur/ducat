import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DatabaseUnavailable } from "./DatabaseUnavailable";
import type { DatabaseFailure } from "../lib/ui/dbHealth";

/**
 * ASSERTIONS HERE ARE ON WHAT IS PRESENT, deliberately and without exception.
 *
 * The outage that produced this component nearly produced a false verification
 * twice: every probe was written to check that the old text was GONE, and a
 * check that a string is absent passes on a page that never rendered at all —
 * which is precisely the state under test. Both the login redirect and the
 * error boundary came back "clean" that way. So each case below names a
 * sentence the reader must actually see.
 *
 * The one apparent exception proves the rule: the missing-table case asserts
 * that no "nothing was lost" reassurance is rendered. That is a claim about a
 * structure this test built and rendered itself, three lines up — not a probe
 * of a page that may have failed to load.
 *
 * createElement rather than JSX, matching MiniDonut.test.ts.
 */

const render = (failure: DatabaseFailure, cloud: boolean, target: string | null = "host") =>
  renderToStaticMarkup(
    createElement(DatabaseUnavailable, { failure, cloud, target, path: "/trends" }),
  );

const UNREACHABLE: DatabaseFailure = { kind: "unreachable", detail: "HTTP 502" };

describe("DatabaseUnavailable", () => {
  it("names the condition instead of saying something went wrong", () => {
    const html = render(UNREACHABLE, true, "ducat-prod.turso.io");
    expect(html).toContain("Database unreachable");
    expect(html).toContain("could not get an answer from its database");
  });

  it("says the data is not gone, because a serving failure says nothing about storage", () => {
    const html = render(UNREACHABLE, true);
    expect(html).toContain("it does not mean anything was lost");
    expect(html).toContain("says nothing about what is stored in it");
  });

  it("says it may be temporary without claiming to know whose fault it is", () => {
    const html = render(UNREACHABLE, true);
    expect(html).toContain("It may be temporary");
    // The app cannot tell these three apart, so it names all three rather than
    // picking one. Asserting the sentence is here is the point: a version that
    // blamed the provider would still pass a test that only checked the heading.
    expect(html).toContain("an outage, a revoked token and a lapsed plan all look the same");
  });

  it("gives local mode the advice that fits local mode", () => {
    const html = render(UNREACHABLE, false, "./data/ducat.db");
    expect(html).toContain("DATABASE_URL points where you think it does");
    expect(html).toContain("Path: ");
    expect(html).toContain("./data/ducat.db");
  });

  it("prints the observed evidence — the host and the status — as facts, not a diagnosis", () => {
    const html = render(UNREACHABLE, true, "ducat-prod.turso.io");
    expect(html).toContain("Host: ");
    expect(html).toContain("ducat-prod.turso.io");
    expect(html).toContain("Reported: ");
    expect(html).toContain("HTTP 502");
  });

  it("offers a retry that returns to the page the reader was on", () => {
    expect(render(UNREACHABLE, true)).toContain('href="/trends"');
  });

  it("tells a local checkout with no tables how to create them", () => {
    const html = render({ kind: "no-tables", detail: "Setting" }, false, "./data/ducat.db");
    expect(html).toContain("Database schema is incomplete");
    expect(html).toContain("it has no Setting table");
    expect(html).toContain("npx prisma migrate deploy");
    expect(html).toContain("npm run db:seed");
  });

  it("names both routes for a cloud instance, since empty and behind need different commands", () => {
    // schema:push REFUSES a database with no tables at all, so offering it
    // alone left the empty case with an instruction that cannot work.
    const html = render({ kind: "no-tables", detail: "Setting" }, true, "ducat-prod.turso.io");
    expect(html).toContain("npm run turso:push");
    expect(html).toContain("npm run schema:push");
  });

  it("blames neither cause, because one missing table cannot tell them apart", () => {
    // A database one release behind throws exactly this error while holding a
    // year of real transactions, so "the schema was never applied" would be
    // false. The sentence has to carry both readings.
    const html = render({ kind: "no-tables", detail: "Setting" }, false);
    expect(html).toContain("either its schema was never applied, or it was applied before the release");
  });

  it("withholds the reassurance where it would be false", () => {
    // A missing table IS a real absence. Every other state may promise nothing
    // was lost; this one may not, and the difference is the whole doctrine.
    expect(render({ kind: "no-tables", detail: "Setting" }, false)).not.toContain("anything was lost");
  });

  it("names no cause for a failed open, because SQLITE_CANTOPEN does not report one", () => {
    // Code 14 covers a missing folder, a path naming a directory, and a
    // permissions refusal alike; the classifier does not even parse it out.
    const html = render({ kind: "unopenable", detail: null }, false, "./data/nope/x.db");
    expect(html).toContain("The open itself did not succeed");
    expect(html).toContain("names the database file rather than the folder holding it");
  });

  it("distinguishes a path that does not resolve from a file that is not a database", () => {
    expect(render({ kind: "unopenable", detail: null }, false, "./data/nope/x.db")).toContain(
      "found no database it could open at this path",
    );
    expect(render({ kind: "not-a-database", detail: null }, false, "./data/x.db")).toContain(
      "it is not a SQLite database",
    );
  });

  it("keeps the reader's filters on retry — the control re-asks the SAME question", () => {
    // The path arrives already composed with the query (DatabaseNotice.tsx);
    // retrying a filtered ledger to a bare /transactions would silently drop
    // the page, the filters and the payee queue.
    const html = renderToStaticMarkup(
      createElement(DatabaseUnavailable, {
        failure: UNREACHABLE,
        cloud: true,
        target: "host",
        path: "/transactions?payees=1&period=2026-03&page=4",
      }),
    );
    expect(html).toContain('href="/transactions?payees=1&amp;period=2026-03&amp;page=4"');
  });
});
