import 'dotenv/config';
import { installRulePack } from '../src/lib/sync/rulePack';
import { prisma } from '../src/lib/prisma';

/**
 * Installs the starter categorization pack (categories + brand rules +
 * generic-word heuristics) and retroactively categorizes existing
 * transactions. Idempotent: re-running only adds what's missing.
 * Usage: npm run rules:install
 */
async function main(): Promise<void> {
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
