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
 * never edits a rule you have changed. The PACK INSTALL is the only part that
 * depends on anything being pending. Insights regenerate on every real run,
 * because analyzer math ships with `git pull` exactly as rules do and reaches
 * stored rows through nothing at all — so a release that changed only the
 * analyzers has no other way to reach a screen, and categories and insight
 * rows cannot end up disagreeing either (the contract `retarget-rule.ts`
 * holds). It therefore WRITES ROWS every real run, current pack or not.
 *
 * Regeneration is MONTH only — the granularity every screen reads
 * (`ui/insightRows.ts`). WEEK/QUARTER/YEAR rows exist only where somebody ran
 * `insights:generate --granularity=`, are read by nothing, and stay as they
 * are until that same command refreshes them.
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
    // The count above decides the pack install and nothing else, so reporting
    // it alone would understate what a real run does.
    console.log('\n--check: nothing written.');
    console.log('A real run regenerates the monthly insight rows whatever that count says.');
    return;
  }

  if (pending > 0) {
    const result = await installRulePack(prisma);
    console.log(`  Categories created: ${result.categoriesCreated}`);
    console.log(`  Rules created: ${result.rulesCreated} (${result.rulesSkipped} already present)`);
    console.log(`  Transactions recategorized: ${result.transactionsRecategorized}`);
  }

  // Unconditional, and the pack count above must never gate it: installRulePack
  // regenerates only when it MOVED ROWS, and an upgrade shipping no new rules
  // still ships analyzer math the stored rows predate. An early return above
  // this line ("Nothing to do.") defeated exactly that, and made the one command
  // the docs point at after `git pull` a no-op in the commonest case.
  const insights = await generateInsights(prisma, { granularity: 'MONTH' });
  console.log(`\nInsights regenerated: ${insights.created} across ${insights.periods.length} months`);

  console.log(
    '\nDone. DATA does not travel with git push: run this against the CLOUD, and the nightly backup mirrors ' +
      "local from it. A run against local makes tonight's mirror refuse.",
  );
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
