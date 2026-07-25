import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

/**
 * Wipes every row from the local database — accounts, transactions, snapshots,
 * categories, rules, insights, sync history, subscriptions, and settings.
 *
 * Unlike `npm run db:seed`, this also clears the `Setting` table, which holds
 * the `lastSync:<connector>` marker. Leaving that marker behind makes the next
 * sync fetch only a short incremental window instead of full history — so a
 * "start over" that skipped it would silently under-fetch.
 *
 * Destructive and irreversible locally; connector data can be re-synced.
 * Requires --yes so it can never run by accident.
 *
 * Usage: npm run db:reset -- --yes
 */
async function main(): Promise<void> {
  if (!process.argv.includes('--yes')) {
    console.error('Refusing to wipe without confirmation.');
    console.error('This deletes ALL local data (including manual categorizations).');
    console.error('Re-run: npm run db:reset -- --yes');
    process.exit(1);
  }

  await prisma.insight.deleteMany();
  await prisma.balanceSnapshot.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.rule.deleteMany();
  await prisma.category.deleteMany();
  await prisma.account.deleteMany();
  await prisma.syncLog.deleteMany();
  await prisma.trackedSubscription.deleteMany();
  await prisma.setting.deleteMany();

  console.log('Database wiped. Next sync will fetch full history.');
  console.log('  SimpleFIN: npm run sync:simplefin -- --since=YYYY-MM-DD');
  console.log('  Fixtures:  npm run db:seed && npm run insights:generate');
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
