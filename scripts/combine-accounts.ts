/**
 * Combine an account into another that holds the same money under a new
 * number (src/lib/sync/combine.ts): every row moves, balances sum by day,
 * the old account's closing run of zeros is dropped, and the sync passes its
 * feed id over from then on.
 *
 *   npm run accounts:combine -- --from=<id or number> --into=<id or number>           # dry run
 *   npm run accounts:combine -- --from=<id or number> --into=<id or number> --apply   # combine
 *   npm run accounts:combine -- --undo=<id or number of the kept account>
 *   npm run accounts:combine -- --mark-move=<kept account> [--apply]   # a combine done before arrivals were marked
 *
 * An account can be named by its id or by the number at the end of its name,
 * when exactly one account carries it. Names its database first, as every
 * row-writer does.
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { applyCombine, findAccount, markCombinedMove, planCombine, undoCombine, type CombinedMove } from '../src/lib/sync/combine';
import { arg, hasFlag } from './args';
import { databaseLabel } from './database-label';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const moveText = (m: CombinedMove | null) =>
  m === null
    ? "no single arrival of the old account's money found; nothing marked"
    : `the arrival of ${m.amount.toFixed(2)} on ${m.date.toISOString().slice(0, 10)} counts as a move inside the account, not new money`;

async function main(): Promise<void> {
  console.log(`\nDatabase: ${databaseLabel()}\n`);

  const undoRef = arg('undo');
  if (undoRef !== undefined) {
    const into = await findAccount(prisma, undoRef);
    if (into === null) throw new Error(`No single account matches "${undoRef}".`);
    const result = await undoCombine(prisma, into.id);
    console.log(result.ok ? 'Undone: the old account, its rows and its balances are back.' : `Refused: ${result.message}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const markRef = arg('mark-move');
  if (markRef !== undefined) {
    const into = await findAccount(prisma, markRef);
    if (into === null) throw new Error(`No single account matches "${markRef}".`);
    const result = await markCombinedMove(prisma, into.id, hasFlag('apply'));
    if (!result.ok) {
      console.log(`Refused: ${result.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${into.institution} ${into.name}: ${moveText(result.move)}.`);
    if (result.alreadyMarked) console.log('Already marked: nothing to do.');
    else if (result.move !== null) console.log(hasFlag('apply') ? 'Marked. Insights regenerated.' : 'Dry run: nothing was written. Re-run with --apply to mark it.');
    return;
  }

  const fromRef = arg('from');
  const intoRef = arg('into');
  if (fromRef === undefined || intoRef === undefined) {
    throw new Error('Name both accounts: -- --from=<id or number> --into=<id or number>');
  }
  const [from, into] = await Promise.all([findAccount(prisma, fromRef), findAccount(prisma, intoRef)]);
  if (from === null) throw new Error(`No single account matches --from=${fromRef}.`);
  if (into === null) throw new Error(`No single account matches --into=${intoRef}.`);
  console.log(`Combine ${from.institution} ${from.name} INTO ${into.institution} ${into.name} (kept).`);

  const plan = await planCombine(prisma, from.id, into.id);
  console.log(
    `  ${plural(plan.rowsMoved, 'row')} move; ${plural(plan.snapshotsMoved, 'balance')} move, ` +
      `${plural(plan.snapshotsSummed, 'day')} sum with the kept account's, ` +
      `${plural(plan.trailingZerosDropped, 'closing zero balance')} dropped.`,
  );
  console.log(`  And ${moveText(plan.internalMove)}.`);
  if (plan.clashingRowIds > 0) {
    console.log(`  Refused: ${plural(plan.clashingRowIds, 'row')} sit in both under the same feed id. Use accounts:relink.`);
    process.exitCode = 1;
    return;
  }
  if (!hasFlag('apply')) {
    console.log('\nDry run: nothing was written. Re-run with --apply to combine.');
    return;
  }
  const result = await applyCombine(prisma, from.id, into.id);
  if (!result.ok) {
    console.log(`  Refused: ${result.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  Combined. Insights regenerated. Undo: npm run accounts:combine -- --undo=${into.id}`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
