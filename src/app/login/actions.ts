"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyPassword } from "../../lib/auth/password";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "../../lib/auth/session";

/**
 * Verify the app password (Node runtime — scrypt) and issue the signed session
 * cookie. Runs only from `/login`, which middleware allow-lists. On failure we
 * redirect back with a generic error (no user enumeration; scrypt's cost is the
 * natural brute-force brake for a single-user gate).
 */
export async function login(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  const hash = process.env.AUTH_PASSWORD_HASH;
  if (hash === undefined || hash === "" || !verifyPassword(password, hash)) {
    redirect("/login?error=1");
  }

  const token = await createSessionToken();
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  redirect("/");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
