import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";
import { createSessionToken, verifySessionToken } from "./session";

describe("password (scrypt)", () => {
  it("verifies the correct password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("uses a fresh salt each time (same password → different hash)", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored hashes without throwing", () => {
    expect(verifyPassword("x", "")).toBe(false);
    expect(verifyPassword("x", "plain")).toBe(false);
    expect(verifyPassword("x", "notscrypt$aa$bb")).toBe(false);
  });
});

describe("session (jose HS256)", () => {
  beforeAll(() => {
    process.env.SESSION_SECRET = "test-secret-for-vitest-only-not-a-real-key";
  });

  it("round-trips a valid token and rejects tampered/garbage tokens", async () => {
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
    expect(await verifySessionToken(`${token}tampered`)).toBe(false);
    expect(await verifySessionToken("garbage")).toBe(false);
  });
});
