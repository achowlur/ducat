"use server";

import { revalidatePath } from "next/cache";
import { revalidateInsightPages } from "./revalidate";
import { prisma } from "../lib/prisma";
import { databaseRefusal, refuse } from "../lib/actionResult";
import { SimplefinConnector } from "../lib/connectors/simplefin";
import { SyncAlreadyRunningError } from "../lib/sync/lock";
import { runSync } from "../lib/sync/sync";
import { dateTime } from "../lib/ui/format";
import { simplefinRequestsToday, syncNowRefusal } from "../lib/usage/limits";
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
 *
 * It is capped where the cron is not: the bridge disables a token past 24
 * requests a day, and taps are what could get there (limits.ts). Every way it
 * can fail comes back as a sentence beside the button, never raw driver text.
 */
export async function syncNow(): Promise<SyncNowResult> {
  await requireSession();

  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  if (accessUrl === undefined || accessUrl === "") {
    return { ok: false, message: "No SimpleFIN feed configured." };
  }

  try {
    const capped = syncNowRefusal(await simplefinRequestsToday(prisma));
    if (capped !== null) return refuse(capped);

    const result = await runSync(prisma, new SimplefinConnector(accessUrl), {});
    revalidateInsightPages();
    for (const path of ["/accounts", "/transactions", "/providers"]) {
      revalidatePath(path);
    }
    const n = result.transactionsImported;
    return {
      ok: true,
      message: n === 0 ? "Up to date, no new transactions." : `Synced ${n} new transaction${n === 1 ? "" : "s"}.`,
    };
  } catch (e) {
    if (e instanceof SyncAlreadyRunningError) {
      return refuse(
        `A sync is already running, and its rows appear when it finishes. If it stopped partway, Sync now works again after ${dateTime(e.expiresAt)}.`,
      );
    }
    // runSync/connector errors are already credential-safe (Session 6 redaction).
    return databaseRefusal(e) ?? refuse(e instanceof Error ? e.message : "Sync failed.");
  }
}
