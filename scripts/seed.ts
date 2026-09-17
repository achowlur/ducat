import 'dotenv/config';
import { generateInsights } from '../src/lib/insights/engine';
import { prisma } from '../src/lib/prisma';
import { installRulePack } from '../src/lib/sync/rulePack';
import { printDatabase } from './database-label';
import { buildDemoData, writeDemoData } from './demoData';

/**
 * Loads the invented demo data (scripts/demoData.ts), dated relative to
 * TODAY, then does what a real instance does after its first sync: installs
 * the rule pack and builds the insights — so every screen has something to
 * show the moment this finishes. Deterministic for a given day.
 */
async function main(): Promise<void> {
  printDatabase();
  // Seeding WIPES everything first. That is fine on an empty database and
  // catastrophic on a real one — a year of imported transactions, every MANUAL
  // categorization and every tuned rule, gone with no prompt. Refuse unless the
  // database is empty or the caller says --yes, matching db:reset's guard.
  const existing = await prisma.transaction.count();
  if (existing > 0 && !process.argv.includes('--yes')) {
    console.error(`Refusing to seed: ${existing} transactions already exist.`);
    console.error('Seeding DELETES all accounts, transactions, rules, categories and insights first.');
    console.error('If you really want the demo data, re-run: npm run db:seed -- --yes');
    process.exit(1);
  }

  await prisma.insight.deleteMany();
  await prisma.balanceSnapshot.deleteMany();
  await prisma.transaction.updateMany({ data: { transferPairId: null, reimbursesId: null } });
  await prisma.transaction.deleteMany();
  await prisma.rule.deleteMany();
  await prisma.category.deleteMany();
  await prisma.account.deleteMany();
  await prisma.syncLog.deleteMany();
  await prisma.trackedSubscription.deleteMany();
  // Settings that describe the data being wiped: the demo's own declarations,
  // cash pointing at accounts that no longer exist, each connector's sync
  // cursor, and the previous database's backup record — left behind, /providers
  // would report a backup of data this database no longer holds. Auth state is
  // not data and stays.
  await prisma.setting.deleteMany({
    where: {
      OR: [
        { key: { in: ['goals.savings', 'readiness.house', 'cash.additionalAccountIds', 'backup.lastRun'] } },
        { key: { startsWith: 'lastSync:' } },
      ],
    },
  });

  const plan = buildDemoData(new Date());
  await writeDemoData(prisma, plan);
  const newestSync = plan.syncTimes[plan.syncTimes.length - 1];
  await prisma.setting.create({ data: { key: 'lastSync:SIMPLEFIN', value: newestSync.toISOString() } });
  const pack = await installRulePack(prisma);
  await generateInsights(prisma);

  console.log('Seeded demo data:', {
    accounts: await prisma.account.count(),
    transactions: await prisma.transaction.count(),
    snapshots: await prisma.balanceSnapshot.count(),
    rules: await prisma.rule.count(),
    insights: await prisma.insight.count(),
    packRulesInstalled: pack,
  });
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
