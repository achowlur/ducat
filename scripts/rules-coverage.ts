/**
 * How much the shipped rule pack categorizes on its own, measured on a real
 * history: what a NEW install of this code would do with these rows before
 * anyone has reviewed a thing.
 *
 * Read-only. Runs the code's PACK_RULES (never the database's installed
 * rules, which lag the code until `npm run upgrade`, and never the
 * operator's own rules, which a new install does not have) through the real
 * matcher over every row that is neither a transfer nor inside an investment
 * account, as if none had been categorized yet. Reports:
 *
 *   COVERAGE    rows the pack categorizes, of the rows it may categorize at
 *               all (P2P payments are held for review by design, so they are
 *               counted apart and never in the denominator);
 *   AGREEMENT   of those rows the operator has categorized since, how many
 *               the pack put in the same category. A change that lifts
 *               coverage and drops agreement is a guess, not a rule;
 *   DISAGREEMENTS and MISSED payees, most rows first: where the next rule
 *               would pay off, and where the last one is wrong.
 *
 * The figures and payees are this operator's own, so the output stays on this
 * machine: never paste it into a commit, a PR or a doc (publishing.md).
 *
 * Real rows measure what a rule WINS. They cannot show what it would wrongly
 * claim at a merchant this operator never visited, which is the corpus in
 * rulePack.test.ts and `npm run rules:simulate`'s job; a pack change owes all
 * three.
 *
 *   npm run rules:coverage [-- --top=30]
 */
import { prisma } from '../src/lib/prisma';
import { isP2P } from '../src/lib/p2p';
import { isClosedBox } from '../src/lib/sync/closedBox';
import { PACK_RULES } from '../src/lib/sync/rulePack';
import { applyRules, type RuleData, type RuleTxn } from '../src/lib/sync/rules';
import { merchantKey } from '../src/lib/ui/merchantLabel';
import { databaseLabel } from './database-label';

const topArg = process.argv.find((a) => a.startsWith('--top='));
const TOP = topArg === undefined ? 25 : Math.max(1, Number(topArg.slice('--top='.length)) || 25);

const percent = (part: number, whole: number) => (whole === 0 ? '—' : `${Math.round((100 * part) / whole)}%`);

async function main(): Promise<void> {
  console.log(`\nDatabase: ${databaseLabel()}\n`);

  const [categories, rows] = await Promise.all([
    prisma.category.findMany({ select: { id: true, name: true } }),
    prisma.transaction.findMany({
      where: { flow: { not: 'TRANSFER' } },
      select: {
        id: true,
        amount: true,
        description: true,
        normalizedMerchant: true,
        categoryId: true,
        account: { select: { name: true, type: true } },
      },
    }),
  ]);
  const nameOf = new Map(categories.map((c) => [c.id, c.name]));

  // The pack as a fresh install holds it: category NAMES stand in for ids,
  // which is what lets the comparison below read across databases.
  const pack: RuleData[] = PACK_RULES.map((r, i) => ({
    id: `pack-${i}`,
    priority: r.priority,
    matchField: r.matchField,
    matchOperator: r.matchOperator,
    matchValue: r.matchValue,
    setCategoryId: r.category,
    setFlow: r.setFlow ?? null,
    enabled: true,
  }));

  const open = rows.filter((t) => !isClosedBox(t.account.type));
  const p2p = open.filter((t) => isP2P(t));
  const eligible = open.filter((t) => !isP2P(t));
  const txns: RuleTxn[] = eligible.map((t) => ({
    id: t.id,
    amount: Number(t.amount),
    description: t.description,
    normalizedMerchant: t.normalizedMerchant,
    accountName: t.account.name,
    accountType: t.account.type,
    categorySource: 'AGGREGATOR',
  }));
  const byPack = new Map(applyRules(pack, txns).map((a) => [a.txnId, a]));

  const claimed = eligible.filter((t) => byPack.get(t.id)?.categoryId != null);
  const yours = (t: (typeof eligible)[number]) => (t.categoryId === null ? null : (nameOf.get(t.categoryId) ?? null));
  const judged = claimed.filter((t) => yours(t) !== null);
  const agreed = judged.filter((t) => yours(t) === byPack.get(t.id)?.categoryId);

  console.log(`Rows the pack may categorize (not transfers, not investment, not P2P): ${eligible.length}`);
  console.log(`  P2P payments, held for review by design:                          ${p2p.length}`);
  console.log(`COVERAGE   the pack alone categorizes ${claimed.length} of ${eligible.length} (${percent(claimed.length, eligible.length)})`);
  console.log(`AGREEMENT  of the ${judged.length} of those you have categorized, ${agreed.length} match yours (${percent(agreed.length, judged.length)})`);

  const tally = (list: typeof eligible, key: (t: (typeof eligible)[number]) => string) => {
    const counts = new Map<string, number>();
    for (const t of list) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  };

  const wrong = tally(
    judged.filter((t) => yours(t) !== byPack.get(t.id)?.categoryId),
    (t) => `${merchantKey(t)}: pack says ${byPack.get(t.id)?.categoryId}, you said ${yours(t)}`,
  );
  console.log(`\nDISAGREEMENTS (${wrong.reduce((n, [, c]) => n + c, 0)} rows)`);
  for (const [line, n] of wrong.slice(0, TOP)) console.log(`  ${String(n).padStart(4)}  ${line}`);

  const missed = eligible.filter((t) => byPack.get(t.id)?.categoryId == null);
  const payees = tally(missed, (t) => `${merchantKey(t)}${yours(t) === null ? '' : `  [you: ${yours(t)}]`}`);
  const once = payees.filter(([, n]) => n === 1).length;
  console.log(`\nMISSED  ${missed.length} rows in ${payees.length} payees, ${once} of them seen once`);
  for (const [line, n] of payees.slice(0, TOP)) console.log(`  ${String(n).padStart(4)}  ${line}`);
  console.log('\nThese figures are this database\'s own: keep them out of commits, PRs and docs.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
