/**
 * Re-link accounts a reconnect forked (src/lib/sync/relink.ts), the command
 * twin of the Merge offer on /accounts: one function serves both.
 *
 *   npm run accounts:relink                      # dry run: every pair offered, and what merging it would do
 *   npm run accounts:relink -- --apply           # merge every pair offered
 *   npm run accounts:relink -- --undo=<id>       # put back the merge into the account with that id
 *
 * Names its database first, as every row-writer does: the merge moves rows,
 * deletes an account and regenerates insights in whichever DATABASE_URL the
 * shell holds.
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { applyRelink, currentRelinkPairs, planRelink, undoRelink } from '../src/lib/sync/relink';
import { arg, hasFlag } from './args';
import { databaseLabel } from './database-label';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function main(): Promise<void> {
  console.log(`\nDatabase: ${databaseLabel()}\n`);

  const undo = arg('undo');
  if (undo !== undefined) {
    const result = await undoRelink(prisma, undo);
    console.log(result.ok ? 'Undone: both accounts are as they were before the merge.' : `Refused: ${result.message}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const pairs = await currentRelinkPairs(prisma);
  if (pairs.length === 0) {
    console.log('No reconnected accounts to re-link: every account the feed lists is the one it always was.');
    return;
  }
  const apply = hasFlag('apply');
  for (const p of pairs) {
    console.log(`${p.institution}: ${p.newName} (new) looks like ${p.oldName} (last balance ${p.oldBalanceDate.toISOString().slice(0, 10)})`);
    if (apply) {
      const result = await applyRelink(prisma, p.oldId, p.newId);
      if (!result.ok) {
        console.log(`  Refused: ${result.message}`);
        process.exitCode = 1;
        continue;
      }
      const r = result.result;
      console.log(
        `  Merged: ${plural(r.moved + r.ambiguous, 'row')} moved (${r.ambiguous} kept for review), ` +
          `${plural(r.duplicates, 'copy')} dropped, ${plural(r.unpaired, 'transfer link')} left unpaired.`,
      );
      console.log(`  Undo: npm run accounts:relink -- --undo=${p.oldId}`);
    } else {
      const plan = await planRelink(prisma, p.oldId, p.newId);
      console.log(
        `  Would move ${plural(plan.move.length, 'row')}, drop ${plural(plan.duplicates.length, 'copy')} of rows already held, ` +
          `keep ${plural(plan.ambiguous.length, 'undecided row')} for review, and move ${plural(plan.snapshotsMoved, 'balance snapshot')} ` +
          `(${plan.snapshotsReplaced} replacing one on the same day).`,
      );
    }
  }
  if (!apply) console.log('\nDry run: nothing was written. Re-run with -- --apply to merge.');
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
