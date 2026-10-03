"use server";

import { revalidatePath } from "next/cache";
import { revalidateInsightPages } from "../revalidate";
import { prisma } from "../../lib/prisma";
import { generateInsights } from "../../lib/insights/engine";
import { isClosedBox } from "../../lib/sync/closedBox";
import { reapplyRules, releaseClosedBox } from "../../lib/sync/rulePack";
import { requireSession } from "../../lib/auth/requireSession";
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
  await generateInsights(prisma);
  revalidatePath("/accounts");
  // The ledger prints each row's flow, which a move across the box rewrites.
  revalidatePath("/transactions");
  revalidateInsightPages();
}
