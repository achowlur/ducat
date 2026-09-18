import type { PrismaClient } from '../../generated/prisma/client';
import { generateInsights } from '../insights/engine';
import { installRulePack, type InstallResult } from '../sync/rulePack';
import { buildDemoData, writeDemoData } from './data';

/**
 * Replace every row of financial data with the invented demo data as of `now`,
 * then do what a real instance does after its first sync: install the rule
 * pack and build the insights.
 *
 * Shared by `npm run db:seed` (which refuses over existing transactions unless
 * told otherwise) and the public demo's nightly cron (which resets whatever
 * visitors changed during the day, and moves the data forward so the month
 * being lived in is never empty). Callers decide WHETHER to wipe; this only
 * knows HOW.
 *
 * Settings describing the wiped data go too — the demo's own declarations,
 * cash pointing at accounts that no longer exist, every connector's sync
 * cursor, and a backup record of data this database no longer holds. Auth
 * state is not data and stays, or a reset would re-open a one-use TOTP code.
 */
export async function reseedDemo(
  prisma: PrismaClient,
  now: Date,
): Promise<{ transactions: number; insights: number; pack: InstallResult }> {
  await prisma.insight.deleteMany();
  await prisma.balanceSnapshot.deleteMany();
  await prisma.transaction.updateMany({ data: { transferPairId: null, reimbursesId: null } });
  await prisma.transaction.deleteMany();
  await prisma.rule.deleteMany();
  await prisma.category.deleteMany();
  await prisma.account.deleteMany();
  await prisma.syncLog.deleteMany();
  await prisma.trackedSubscription.deleteMany();
  await prisma.setting.deleteMany({
    where: {
      OR: [
        { key: { in: ['goals.savings', 'readiness.house', 'cash.additionalAccountIds', 'backup.lastRun'] } },
        { key: { startsWith: 'lastSync:' } },
      ],
    },
  });

  const plan = buildDemoData(now);
  await writeDemoData(prisma, plan);
  const newestSync = plan.syncTimes[plan.syncTimes.length - 1];
  await prisma.setting.create({ data: { key: 'lastSync:SIMPLEFIN', value: newestSync.toISOString() } });
  const pack = await installRulePack(prisma);
  const insights = await generateInsights(prisma);
  return { transactions: plan.txns.length, insights: insights.created, pack };
}
