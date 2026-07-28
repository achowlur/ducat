/**
 * One-off: categorize the two rows the 2026-07-28 sync left uncategorized, by
 * fixing the rules behind them rather than hand-setting the categories.
 *
 * Run once per instance and then delete this file. It exists as a script, not
 * as a hand-run query, for the reason `retarget-rule.ts` does: DATA does not
 * ship with git push, so a rule fixed on the laptop leaves the cloud instance —
 * the one actually being read — saying the old thing. It prints WHICH database
 * it is about to touch before doing anything, and is a dry run unless given
 * `--apply`.
 *
 * 1. `mr sage` matched MERCHANT, and the merchant string differs by SOURCE: the
 *    CSV row normalized to "mr sage" while the feed's clean payee normalized to
 *    "sage", so a rule the operator had already created silently stopped
 *    matching its own restaurant. Both DESCRIPTIONS carry "mr sage", which is
 *    the raw bank text and the thing that does not move.
 * 2. SimpleFIN's own subscription had no rule. Keyed on `simplefin` and not on
 *    `link.com` deliberately: "LINK.COM*" is a payment-rail prefix of exactly
 *    the shape normalizeMerchant already strips for Toast and Square, so a rule
 *    on the rail would break the day that prefix is added to the strip list.
 *
 *   npx tsx scripts/fix-sage-simplefin-rules.ts
 *   npx tsx scripts/fix-sage-simplefin-rules.ts --apply
 */
import { prisma } from '../src/lib/prisma';
import { reapplyRules } from '../src/lib/sync/rulePack';
import { generateInsights } from '../src/lib/insights/engine';

const SAGE_VALUE = 'mr sage';
const SIMPLEFIN_VALUE = 'simplefin';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL ?? 'file:./data/ducat.db';
  const where = url.startsWith('libsql://') ? `CLOUD — ${new URL(url).host}` : `LOCAL — ${url}`;
  console.log(`\nDatabase: ${where}`);
  console.log(apply ? 'Mode: APPLY\n' : 'Mode: DRY RUN (pass --apply to write)\n');

  const subscriptions = await prisma.category.findFirst({ where: { name: 'Subscriptions' } });
  if (subscriptions === null) {
    console.error('No "Subscriptions" category in this database — aborting.');
    process.exitCode = 1;
    return;
  }

  const sageRule = await prisma.rule.findFirst({ where: { matchValue: SAGE_VALUE, enabled: true } });
  if (sageRule === null) {
    console.log(`1. No enabled rule with matchValue "${SAGE_VALUE}" — nothing to fix.`);
  } else if (sageRule.matchField === 'DESCRIPTION') {
    console.log(`1. Rule "${SAGE_VALUE}" already matches DESCRIPTION — already fixed.`);
  } else {
    console.log(`1. p${sageRule.priority}: ${sageRule.matchField} ${sageRule.matchOperator} "${sageRule.matchValue}"`);
    console.log(`      -> DESCRIPTION ${sageRule.matchOperator} "${sageRule.matchValue}"`);
    if (apply) {
      await prisma.rule.update({ where: { id: sageRule.id }, data: { matchField: 'DESCRIPTION' } });
      console.log('      WRITTEN');
    }
  }

  const existing = await prisma.rule.findFirst({
    where: { matchValue: SIMPLEFIN_VALUE, matchField: 'DESCRIPTION', matchOperator: 'CONTAINS' },
  });
  if (existing !== null) {
    console.log(`\n2. Rule DESCRIPTION CONTAINS "${SIMPLEFIN_VALUE}" already exists — skipping.`);
  } else {
    console.log(`\n2. CREATE p50 DESCRIPTION CONTAINS "${SIMPLEFIN_VALUE}" -> Subscriptions`);
    if (apply) {
      await prisma.rule.create({
        data: {
          priority: 50,
          matchField: 'DESCRIPTION',
          matchOperator: 'CONTAINS',
          matchValue: SIMPLEFIN_VALUE,
          setCategoryId: subscriptions.id,
          enabled: true,
        },
      });
      console.log('      WRITTEN');
    }
  }

  const pool = async () =>
    prisma.transaction.findMany({
      where: { categoryId: null, flow: { not: 'TRANSFER' }, reimbursesId: null },
      select: { date: true, amount: true, description: true },
      orderBy: { date: 'desc' },
    });

  const before = await pool();
  console.log(`\nUncategorized before: ${before.length}`);
  for (const p of before) {
    console.log(`   ${p.date.toISOString().slice(0, 10)} ${String(p.amount).padStart(9)}  ${p.description}`);
  }

  if (!apply) {
    console.log('\nDry run — nothing written.');
    return;
  }

  // Rules only ever WRITE, so this returns each row as it was; regenerating
  // insights in the same run is what keeps categories and insight rows from
  // disagreeing, the same contract retarget-rule.ts holds.
  const { changed } = await reapplyRules(prisma);
  console.log(`\nreapplyRules: ${changed} row(s) rewritten`);

  const after = await pool();
  console.log(`Uncategorized after: ${after.length}`);
  for (const p of after) {
    console.log(`   ${p.date.toISOString().slice(0, 10)} ${String(p.amount).padStart(9)}  ${p.description}`);
  }

  const insights = await generateInsights(prisma, { granularity: 'MONTH' });
  console.log(`Insights regenerated: ${insights.created} across ${insights.periods.length} periods`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
