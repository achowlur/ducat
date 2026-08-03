import type { PrismaClient } from "../../generated/prisma/client";

/**
 * Rename a trip/project across EVERY row that carries it — one statement,
 * whole group, never a filtered subset: renaming only the rows a filter
 * happens to show would silently split the trip. Renaming onto a label that
 * already has rows is a MERGE, allowed on purpose (two half-named trips are
 * a real state); the band's control says so before anything is written. A
 * plain rename is reversible by renaming back — a label exists only as the
 * value on its rows, so there is nothing else to move — but a MERGE is not:
 * the partition between the two groups is gone, which is why it warns.
 *
 * Shared by the renameGroup server action and the invariant tests — the
 * restoreTransactions pattern, so the test exercises the real write.
 */
export async function renameGroupRows(
  prisma: PrismaClient,
  from: string,
  to: string,
): Promise<number> {
  if (from === to) return 0;
  const { count } = await prisma.transaction.updateMany({
    where: { groupLabel: from },
    data: { groupLabel: to },
  });
  return count;
}
