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
import { getOverviewData } from "../lib/ui/overview";
import { markDone, NUDGES_DONE_KEY } from "../lib/ui/nextAction";

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

/**
 * Mark done on Overview's "Do this next". Records {key, at} in a Setting, so
 * the nudge stays hidden until data newer than the click arrives for what it
 * is about (nextAction.ts), and is then judged again. It moves nothing and
 * touches no transaction. The nudge is checked against the list the page
 * would show NOW, so a stale page is refused in a sentence, never trusted.
 */
export async function markNudgeDone(input: { key: string }): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  await requireSession();
  if (typeof input.key !== "string" || input.key === "" || input.key.length > 300) {
    return refuse("That could not be read.");
  }
  try {
    const data = await getOverviewData();
    const next = markDone(data.nudgesDone, input.key, new Date(), data.nudges);
    if (!next.ok) return next;
    const value = JSON.stringify(next.done);
    await prisma.setting.upsert({
      where: { key: NUDGES_DONE_KEY },
      create: { key: NUDGES_DONE_KEY, value },
      update: { value },
    });
  } catch (e) {
    const refusal = databaseRefusal(e);
    if (refusal !== null) return refusal;
    throw e;
  }
  revalidatePath("/");
  return { ok: true, message: "Marked done." };
}
