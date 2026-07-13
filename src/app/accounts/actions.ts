"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "../../lib/prisma";
import { generateInsights } from "../../lib/insights/engine";

const ACCOUNT_TYPES = ["DEPOSITORY", "CREDIT", "INVESTMENT", "LOAN"] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Correct an account's type. Sync deliberately never updates type after
 * creation (the SimpleFIN inference only guesses once), so a manual
 * correction here is permanent. Insights regenerate because type drives
 * the net-worth breakdown and the market-gains decomposition — a
 * correction means "it was always this type", so history recomputes.
 */
export async function setAccountType(accountId: string, type: string): Promise<void> {
  if (!ACCOUNT_TYPES.includes(type as AccountType)) {
    throw new Error(`Unknown account type: ${type}`);
  }
  await prisma.account.update({
    where: { id: accountId },
    data: { type: type as AccountType },
  });
  await generateInsights(prisma);
  revalidatePath("/accounts");
  revalidatePath("/");
  revalidatePath("/trends");
  revalidatePath("/insights");
}
