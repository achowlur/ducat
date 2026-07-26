"use server";

import { revalidatePath } from "next/cache";
import { revalidateInsightPages } from "../revalidate";
import { prisma } from "../../lib/prisma";
import { generateInsights } from "../../lib/insights/engine";
import { requireSession } from "../../lib/auth/requireSession";
import { ACCOUNT_TYPES, type AccountType } from "../../types/contracts";

/**
 * Correct an account's type. Sync deliberately never updates type after
 * creation (the SimpleFIN inference only guesses once), so a manual
 * correction here is permanent. Insights regenerate because type drives
 * the net-worth breakdown and the market-gains decomposition — a
 * correction means "it was always this type", so history recomputes.
 */
export async function setAccountType(accountId: string, type: string): Promise<void> {
  await requireSession();
  if (!ACCOUNT_TYPES.includes(type as AccountType)) {
    throw new Error(`Unknown account type: ${type}`);
  }
  await prisma.account.update({
    where: { id: accountId },
    data: { type: type as AccountType },
  });
  await generateInsights(prisma);
  revalidatePath("/accounts");
  revalidateInsightPages();
}
