"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "../../lib/prisma";

/**
 * Dismiss or restore an insight. Dismissals survive regeneration: the
 * engine carries the flag forward to the replacement row with the same
 * identity (see identityOf in src/lib/insights/engine.ts).
 */
export async function setInsightDismissed(insightId: string, dismissed: boolean): Promise<void> {
  await prisma.insight.update({
    where: { id: insightId },
    data: { dismissed },
  });
  revalidatePath("/insights");
  revalidatePath("/");
}
