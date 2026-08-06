import { describe, expect, it } from "vitest";
import { boundaryCopy } from "./boundaryCopy";

/**
 * The branch these pin was dead in production for two independent reasons, and
 * the tests are written so neither can come back silently. Assertions are on
 * text that must be PRESENT, except where the whole point is that a specific
 * over-claim was removed — and those are checked against the returned string,
 * which this test built, not against a page that might have failed to render.
 */
describe("boundaryCopy", () => {
  it("names an expired session and sends the reader to sign in", () => {
    const copy = boundaryCopy({ expired: true, gated: true });
    expect(copy.heading).toBe("Session expired");
    expect(copy.body).toContain("Sign in again to continue");
    expect(copy.signIn).toBe(true);
  });

  it("promises nothing was lost ONLY where that is true", () => {
    // requireSession() is the first statement in every action, so an expired
    // session means nothing ran. A generic failure has no such guarantee: an
    // action can throw after a partial write, and the boundary cannot know.
    expect(boundaryCopy({ expired: true, gated: true }).body).toContain("nothing was lost");
    for (const gated of [true, false]) {
      const generic = boundaryCopy({ expired: false, gated }).body;
      expect(generic).not.toContain("nothing was lost");
      expect(generic).not.toContain("data is unchanged");
      expect(generic).not.toContain("retrying is safe");
      expect(generic).toContain("Reload to see the current state");
    }
  });

  it("stops offering a retry once the session is known to be the problem", () => {
    // reset() re-runs the same render against the same dead session.
    expect(boundaryCopy({ expired: true, gated: true }).retry).toBe(false);
    expect(boundaryCopy({ expired: false, gated: true }).retry).toBe(true);
  });

  it("names a lapsed sign-in as a cause only where a gate exists", () => {
    expect(boundaryCopy({ expired: false, gated: true }).body).toContain("a lapsed sign-in looks exactly like this");
    expect(boundaryCopy({ expired: false, gated: false }).signIn).toBe(false);
  });

  it("offers no sign-in route in local mode, where /login just bounces back", () => {
    const local = boundaryCopy({ expired: false, gated: false });
    expect(local.signIn).toBe(false);
    expect(local.body).toBe("That action didn't complete. Reload to see the current state.");
  });
});
