import 'dotenv/config';
import { installRulePack } from '../src/lib/sync/rulePack';
import { prisma } from '../src/lib/prisma';
import { printDatabase } from './database-label';

/**
 * Installs the starter categorization pack (categories + brand rules +
 * generic-word heuristics) and retroactively categorizes existing
 * transactions. Idempotent: re-running only adds what's missing.
 * Usage: npm run rules:install
 *
 * Names its database first, like every other row-writer. It was the last one
 * that did not, which was the wrong exception to make: this command does not
 * only add rules, it RECATEGORIZES existing transactions and regenerates
 * insights, so running it against the database you did not mean to is a
 * content change you then have to find.
 */
async function main(): Promise<void> {
  printDatabase();
  const result = await installRulePack(prisma);
  console.log('Rule pack installed:');
  console.log(`  Categories created: ${result.categoriesCreated}`);
  console.log(`  Rules created: ${result.rulesCreated} (${result.rulesSkipped} already present)`);
  console.log(`  Transactions recategorized: ${result.transactionsRecategorized}`);
  if (result.transactionsRecategorized > 0) {
    console.log('  Insights regenerated.');
  }
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
