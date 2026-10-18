import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { generateInsights, type GenerateResult } from './engine';

/**
 * Regeneration for an EDIT: only the periods the edit can have changed.
 *
 * Every categorize, link and retype used to rebuild every period of the
 * history and rewrite every row. An edit changes rows from its own date
 * onward (anomaly baselines are the history before a period), so the run
 * starts at the earliest date the edit touched (engine.ts SCOPE_LOOKBACK_MONTHS
 * explains the margin before it). Sync, upgrade and the scripts still run in
 * full.
 */

/** The earliest date among the rows an edit touched, or null when none matched. */
export async function earliestTouched(
  prisma: PrismaClient,
  where: Prisma.TransactionWhereInput,
): Promise<Date | null> {
  const found = await prisma.transaction.aggregate({ where, _min: { date: true } });
  return found._min.date;
}

/** The earliest date an account has any record of: a row or a balance snapshot. */
export async function earliestOfAccount(prisma: PrismaClient, accountId: string): Promise<Date | null> {
  const [row, snapshot] = await Promise.all([
    earliestTouched(prisma, { accountId }),
    prisma.balanceSnapshot.aggregate({ where: { accountId }, _min: { date: true } }),
  ]);
  const dates = [row, snapshot._min.date].filter((d): d is Date => d !== null);
  return dates.length === 0 ? null : new Date(Math.min(...dates.map((d) => d.getTime())));
}

/**
 * Regenerate from `since`. With no date to go by (the edit touched no row, or
 * the rows are gone) it runs in full: a wide run is always correct.
 */
export function regenerateSince(prisma: PrismaClient, since: Date | null): Promise<GenerateResult> {
  return generateInsights(prisma, since === null ? {} : { since });
}

/** Regenerate for an edit to the rows matching `where`, read BEFORE or after as the caller needs. */
export async function regenerateForRows(
  prisma: PrismaClient,
  where: Prisma.TransactionWhereInput,
): Promise<GenerateResult> {
  return regenerateSince(prisma, await earliestTouched(prisma, where));
}
