import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { installRulePack, pendingPackRules } from '../src/lib/sync/rulePack';
import { generateInsights } from '../src/lib/insights/engine';
import { databaseLabel } from './database-label';

/**
 * Bring a database up to date with the code that is checked out.
 *
 * Run this after every `git pull`. It exists because CODE and DATA upgrade
 * separately and only one of them announces itself: a new version can ship
 * categorization rules, and they reach an existing instance through nothing at
 * all. The app keeps running the old rule set, a green deploy says everything
 * is current, and the only symptom is transactions quietly landing in the wrong
 * category. The `zego|paylease` rule sat uninstalled on both databases for
 * weeks exactly this way.
 *
 * Idempotent and safe to run at any time: it creates only what is missing and
 * never edits a rule you have changed. Insights regenerate afterwards so
 * categories and insight rows cannot end up disagreeing — the same contract
 * `retarget-rule.ts` holds.
 *
 * It does NOT touch the schema. A Prisma migration still has to be applied by
 * hand on Turso (see DEPLOY.md); this refuses to pretend otherwise.
 *
 *   npm run upgrade
 *   npm run upgrade -- --check    # report only, write nothing
 */
async function main(): Promise<void> {
  const checkOnly = process.argv.includes('--check');
  console.log(`\nDatabase: ${databaseLabel()}`);

  const pending = await pendingPackRules(prisma);
  if (pending === 0) {
    console.log('\nRule pack: up to date — nothing to install.');
  } else {
    console.log(`\nRule pack: ${pending} rule${pending === 1 ? '' : 's'} in this version are not installed.`);
  }

  if (checkOnly) {
    console.log('\n--check: nothing written.');
    return;
  }
  if (pending === 0) {
    console.log('\nNothing to do.');
    return;
  }

  const result = await installRulePack(prisma);
  console.log(`  Categories created: ${result.categoriesCreated}`);
  console.log(`  Rules created: ${result.rulesCreated} (${result.rulesSkipped} already present)`);
  console.log(`  Transactions recategorized: ${result.transactionsRecategorized}`);

  // installRulePack regenerates insights only when it moved rows. Doing it
  // unconditionally here costs one pass and removes the case where new rules
  // changed nothing today but the stored insights predate them anyway.
  const insights = await generateInsights(prisma, { granularity: 'MONTH' });
  console.log(`  Insights regenerated: ${insights.created} across ${insights.periods.length} periods`);

  console.log('\nDone. Run this once per database — DATA does not travel with git push.');
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
