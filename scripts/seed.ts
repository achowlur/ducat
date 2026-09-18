import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { printDatabase } from './database-label';
import { reseedDemo } from '../src/lib/demo/reseed';

/**
 * Loads the invented demo data (src/lib/demo/data.ts), dated relative to
 * TODAY, then does what a real instance does after its first sync: installs
 * the rule pack and builds the insights — so every screen has something to
 * show the moment this finishes. Deterministic for a given day. The writing is
 * src/lib/demo/reseed.ts, shared with the public demo's nightly reset; the
 * refusal below is this command's alone.
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

  const result = await reseedDemo(prisma, new Date());

  console.log('Seeded demo data:', {
    accounts: await prisma.account.count(),
    transactions: await prisma.transaction.count(),
    snapshots: await prisma.balanceSnapshot.count(),
    rules: await prisma.rule.count(),
    insights: await prisma.insight.count(),
    packRulesInstalled: result.pack,
  });
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
