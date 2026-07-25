"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "../lib/prisma";
import { SimplefinConnector } from "../lib/connectors/simplefin";
import { runSync } from "../lib/sync/sync";
import { requireSession } from "../lib/auth/requireSession";

export interface SyncNowResult {
  ok: boolean;
  message: string;
}

/**
 * Manual "Sync now" — pulls the latest from SimpleFIN on demand, using the same
 * `runSync` the daily cron calls (the window self-selects from the Setting
 * table). This is a user-initiated request, NOT a scheduled Vercel Cron, so it
 * isn't subject to the once-a-day Hobby cron cap — it just counts as an ordinary
 * function invocation. Session-gated like every other mutation.
 */
export async function syncNow(): Promise<SyncNowResult> {
  await requireSession();

  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  if (accessUrl === undefined || accessUrl === "") {
    return { ok: false, message: "No SimpleFIN feed configured." };
  }

  try {
    const result = await runSync(prisma, new SimplefinConnector(accessUrl), {});
    for (const path of ["/", "/trends", "/insights", "/accounts", "/transactions", "/providers"]) {
      revalidatePath(path);
    }
    const n = result.transactionsImported;
    return {
      ok: true,
      message: n === 0 ? "Up to date — no new transactions." : `Synced ${n} new transaction${n === 1 ? "" : "s"}.`,
    };
  } catch (e) {
    // runSync/connector errors are already credential-safe (Session 6 redaction).
    return { ok: false, message: e instanceof Error ? e.message : "Sync failed." };
  }
}
