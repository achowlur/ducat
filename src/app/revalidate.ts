import { revalidatePath } from "next/cache";

/**
 * The pages rendered FROM generated insights. Any action that calls
 * generateInsights has changed all three, so all three expire together.
 *
 * Listed once because listing them per action is how they drifted:
 * setTransactionCategory, linkReimbursement and unlinkReimbursement each
 * expired "/" and "/trends" but not "/insights", while upsertRule and
 * setAccountType — the same regeneration, four lines away — expired all four.
 */
export function revalidateInsightPages(): void {
  for (const path of ["/", "/trends", "/insights"]) revalidatePath(path);
}
