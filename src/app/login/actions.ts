"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isTotpConfigured } from "../../lib/auth/mode";
import { verifyPassword } from "../../lib/auth/password";
import {
  createDeviceToken,
  createSessionToken,
  DEVICE_COOKIE,
  DEVICE_MAX_AGE,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  verifyDeviceToken,
} from "../../lib/auth/session";
import { TOTP_COUNTER_SETTING_KEY, verifyTotp } from "../../lib/auth/totp";
import { prisma } from "../../lib/prisma";

/**
 * Verify the app password (Node runtime — scrypt) and, when AUTH_TOTP_SECRET
 * is set, the authenticator code — then issue the signed session cookie. Runs
 * only from `/login`, which middleware allow-lists. On any failure we
 * redirect back with ONE generic error: which factor failed is exactly what
 * an attacker holding half the credentials wants to know.
 *
 * Order is deliberate: the password check runs FIRST, so guessing TOTP codes
 * costs an scrypt verify per attempt — the same brute-force brake the
 * password already has. The accepted counter is persisted as the replay
 * floor (one-use codes); reading and writing it makes login depend on the
 * database, which costs nothing real — every page after login needs the
 * database anyway.
 */
export async function login(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const hash = process.env.AUTH_PASSWORD_HASH;
  if (hash === undefined || hash === "" || !verifyPassword(password, hash)) {
    redirect("/login?error=1");
  }

  // A remembered device waives the CODE, never the password — and the check
  // happens HERE, not on the page that drew the form: a hidden field or a
  // missing input proves nothing, the signed cookie does.
  const deviceToken = (await cookies()).get(DEVICE_COOKIE)?.value;
  const remembered =
    deviceToken !== undefined && (await verifyDeviceToken(deviceToken));
  let passedTotpNow = false;

  if (isTotpConfigured() && !remembered) {
    const code = String(formData.get("code") ?? "");
    const row = await prisma.setting.findUnique({ where: { key: TOTP_COUNTER_SETTING_KEY } });
    const stored = Number(row?.value ?? "0");
    const floor = Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
    const accepted = verifyTotp(process.env.AUTH_TOTP_SECRET ?? "", code, Date.now(), floor);
    if (accepted === null) {
      redirect("/login?error=1");
    }

    // CLAIM the floor by compare-and-set, don't just write it: a plain upsert
    // is read-check-write, and two logins presenting the SAME code
    // concurrently would both pass verifyTotp against the same floor and
    // both get sessions — the review proved the relay-attack window is real
    // (both requests sit in their ~100ms scrypt verifies before either
    // writes). Advancing ONLY from the exact value this request validated
    // against means one concurrent login claims the code and every other
    // one fails, which is what "one-use" has to mean under concurrency.
    let claimed = false;
    if (row === null) {
      try {
        await prisma.setting.create({
          data: { key: TOTP_COUNTER_SETTING_KEY, value: String(accepted) },
        });
        claimed = true;
      } catch {
        claimed = false; // unique-key loss: another login created the row first
      }
    } else {
      const res = await prisma.setting.updateMany({
        where: { key: TOTP_COUNTER_SETTING_KEY, value: row.value },
        data: { value: String(accepted) },
      });
      claimed = res.count === 1;
    }
    if (!claimed) {
      redirect("/login?error=1");
    }
    passedTotpNow = true;
  }

  const jar = await cookies();
  const token = await createSessionToken();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });

  // Remembering is EARNED by a code presented in this very request — never
  // inherited from an already-remembered login, which would let one
  // enrollment renew itself forever and outlive the 90 days it promised.
  if (passedTotpNow && formData.get("remember") !== null) {
    jar.set(DEVICE_COOKIE, await createDeviceToken(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: DEVICE_MAX_AGE,
    });
  }
  redirect("/");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
