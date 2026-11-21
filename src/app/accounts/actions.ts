"use server";

import { revalidatePath } from "next/cache";
import { revalidateInsightPages } from "../revalidate";
import { prisma } from "../../lib/prisma";
import { earliestOfAccount, regenerateSince } from "../../lib/insights/scope";
import { isClosedBox } from "../../lib/sync/closedBox";
import { reapplyRules, releaseClosedBox } from "../../lib/sync/rulePack";
import { requireSession } from "../../lib/auth/requireSession";
import { databaseRefusal, refuse, type ActionResult } from "../../lib/actionResult";
import { SyncAlreadyRunningError } from "../../lib/sync/lock";
import { applyRelink, dismissRelinkPair } from "../../lib/sync/relink";
import {
  ACCOUNT_NAMES_KEY,
  HIDDEN_ON_OVERVIEW_KEY,
  MAX_ACCOUNT_NAME,
  normalizeAccountName,
  parseAccountNames,
  parseHiddenOnOverview,
} from "../../lib/accountDisplay";
import { ACCOUNT_TYPES, type AccountType } from "../../types/contracts";

/**
 * Correct an account's type. Sync deliberately never updates type after
 * creation (the SimpleFIN inference only guesses once), so a manual
 * correction here is permanent. Insights regenerate because type drives
 * the net-worth breakdown and the market-gains decomposition — a
 * correction means "it was always this type", so history recomputes.
 *
 * So do the account's ROWS, when the correction moves it into or out of the
 * closed box (sync/closedBox.ts). Becoming an investment account takes its
 * rows out of income and spending; ceasing to be one has to put them back,
 * and rules only ever write, so that is done here.
 */
export async function setAccountType(accountId: string, type: string): Promise<void> {
  await requireSession();
  if (!ACCOUNT_TYPES.includes(type as AccountType)) {
    throw new Error(`Unknown account type: ${type}`);
  }
  const before = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { type: true } });
  await prisma.account.update({
    where: { id: accountId },
    data: { type: type as AccountType },
  });
  if (isClosedBox(before.type) !== isClosedBox(type)) {
    if (isClosedBox(before.type)) await releaseClosedBox(prisma, accountId);
    await reapplyRules(prisma);
  }
  // A retype recomputes the account's whole history, rows and balances alike.
  await regenerateSince(prisma, await earliestOfAccount(prisma, accountId));
  revalidatePath("/accounts");
  // The ledger prints each row's flow, which a move across the box rewrites.
  revalidatePath("/transactions");
  revalidateInsightPages();
}

/**
 * Merge an account a reconnect forked into the one it copies (lib/sync/relink.ts).
 * Refuses, in a sentence, when the pair is no longer offered or a sync holds
 * the lock; the result says what moved, so the reader can check it.
 */
export async function mergeReconnectedAccount(
  oldId: string,
  newId: string,
): Promise<ActionResult<{ message: string }>> {
  await requireSession();
  try {
    const outcome = await applyRelink(prisma, oldId, newId);
    if (!outcome.ok) return refuse(outcome.message);
    const { moved, duplicates, ambiguous, unpaired } = outcome.result;
    const parts = [
      `${moved + ambiguous} ${moved + ambiguous === 1 ? "row" : "rows"} moved`,
      `${duplicates} ${duplicates === 1 ? "copy" : "copies"} of rows already here dropped`,
      ...(ambiguous > 0 ? [`${ambiguous} kept because they could not be told apart from a copy: check them in this account's transactions`] : []),
      ...(unpaired > 0 ? [`${unpaired} transfer ${unpaired === 1 ? "link" : "links"} left unpaired`] : []),
    ];
    revalidatePath("/accounts");
    revalidatePath("/transactions");
    revalidateInsightPages();
    return { ok: true, message: `Merged: ${parts.join("; ")}.` };
  } catch (e) {
    if (e instanceof SyncAlreadyRunningError) return refuse("A sync is running. Try again in a minute.");
    const refusal = databaseRefusal(e);
    if (refusal !== null) return refusal;
    throw e;
  }
}

/**
 * Name an account as the reader knows it (lib/accountDisplay.ts). An empty
 * name puts the feed's back. The feed's own name is never touched: sync
 * rewrites it, ACCOUNT rules match it and the reconnect matching reads it.
 */
export async function renameAccount(accountId: string, raw: string): Promise<ActionResult> {
  await requireSession();
  const name = normalizeAccountName(raw);
  if (name !== null && name.length > MAX_ACCOUNT_NAME) {
    return refuse(`A name can be at most ${MAX_ACCOUNT_NAME} characters; the account number is added after it.`);
  }
  try {
    const exists = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true } });
    if (exists === null) return refuse("That account is no longer here. Reload to see the current list.");
    const row = await prisma.setting.findUnique({ where: { key: ACCOUNT_NAMES_KEY } });
    const names = parseAccountNames(row?.value ?? null);
    if (name === null) delete names[accountId];
    else names[accountId] = name;
    const value = JSON.stringify(names);
    await prisma.setting.upsert({ where: { key: ACCOUNT_NAMES_KEY }, create: { key: ACCOUNT_NAMES_KEY, value }, update: { value } });
  } catch (e) {
    const refusal = databaseRefusal(e);
    if (refusal !== null) return refusal;
    throw e;
  }
  // Every page prints account names.
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Leave an account out of Overview's account table, or put it back. No total changes. */
export async function setHiddenOnOverview(accountId: string, hidden: boolean): Promise<ActionResult> {
  await requireSession();
  try {
    const row = await prisma.setting.findUnique({ where: { key: HIDDEN_ON_OVERVIEW_KEY } });
    const ids = parseHiddenOnOverview(row?.value ?? null);
    if (hidden) ids.add(accountId);
    else ids.delete(accountId);
    const value = JSON.stringify([...ids].sort());
    await prisma.setting.upsert({
      where: { key: HIDDEN_ON_OVERVIEW_KEY },
      create: { key: HIDDEN_ON_OVERVIEW_KEY, value },
      update: { value },
    });
  } catch (e) {
    const refusal = databaseRefusal(e);
    if (refusal !== null) return refusal;
    throw e;
  }
  revalidatePath("/");
  revalidatePath("/accounts");
  return { ok: true };
}

/** "Not the same account": the pair is never offered again. */
export async function dismissReconnectedAccount(oldId: string, newId: string): Promise<ActionResult> {
  await requireSession();
  try {
    await dismissRelinkPair(prisma, oldId, newId);
  } catch (e) {
    const refusal = databaseRefusal(e);
    if (refusal !== null) return refusal;
    throw e;
  }
  revalidatePath("/accounts");
  return { ok: true };
}
