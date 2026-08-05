import { beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";
import {
  createDeviceToken,
  createSessionToken,
  verifyDeviceToken,
  verifySessionToken,
} from "./session";

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

  it("a device token is NOT a session token — the escalation both cookies' shared signing key invites", async () => {
    const device = await createDeviceToken();
    // Pasting the remembered-device cookie into fin_session must not grant
    // access: it verifies under the same key and carries the same `pw`, so
    // only the type claim stands between "skip the code" and "no password".
    expect(await verifySessionToken(device)).toBe(false);
    expect(await verifyDeviceToken(device)).toBe(true);
  });

  it("a session token is not accepted as a device token either", async () => {
    const session = await createSessionToken();
    expect(await verifyDeviceToken(session)).toBe(false);
  });

  it("rotating a credential un-remembers every device", async () => {
    const before = process.env.AUTH_TOTP_SECRET;
    try {
      process.env.AUTH_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
      const device = await createDeviceToken();
      expect(await verifyDeviceToken(device)).toBe(true);
      process.env.AUTH_TOTP_SECRET = "ROTATEDROTATEDROTATEDROTATEDROTA";
      expect(await verifyDeviceToken(device)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.AUTH_TOTP_SECRET;
      else process.env.AUTH_TOTP_SECRET = before;
    }
  });

  it("enabling or rotating the TOTP secret evicts existing sessions — the upgrade moment must kill pre-2FA sessions", async () => {
    const before = process.env.AUTH_TOTP_SECRET;
    try {
      delete process.env.AUTH_TOTP_SECRET;
      const pre2fa = await createSessionToken();
      expect(await verifySessionToken(pre2fa)).toBe(true);

      process.env.AUTH_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
      expect(await verifySessionToken(pre2fa)).toBe(false);

      const with2fa = await createSessionToken();
      expect(await verifySessionToken(with2fa)).toBe(true);
      process.env.AUTH_TOTP_SECRET = "ROTATEDROTATEDROTATEDROTATEDROTA";
      expect(await verifySessionToken(with2fa)).toBe(false);
    } finally {
      if (before === undefined) delete process.env.AUTH_TOTP_SECRET;
      else process.env.AUTH_TOTP_SECRET = before;
    }
  });
});
