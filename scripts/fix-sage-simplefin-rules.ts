/**
 * One-off: correct the Mr Sage rule and give SimpleFIN's own charge a rule.
 * Run once per instance and then delete this file.
 *
 * It exists as a script, not a hand-run query, for the reason
 * `retarget-rule.ts` does: DATA does not ship with git push, so a rule fixed on
 * the laptop leaves the cloud instance — the one actually being read — saying
 * the old thing. It prints WHICH database it is about to touch before doing
 * anything, is a dry run unless given `--apply`, and is idempotent.
 *
 * Three things are wrong with the Mr Sage rule and they are independent:
 *
 * 1. WRONG FIELD. It matched MERCHANT, and the merchant string differs by
 *    SOURCE: the CSV row normalized to "mr sage" while the feed's clean payee
 *    normalized to "sage", so a rule the operator had already created silently
 *    stopped matching its own shop. Both DESCRIPTIONS carry "mr sage", which is
 *    raw bank text and does not move.
 * 2. WRONG VALUE, if built from the merchant. A rule on the bare token "sage"
 *    is CONTAINS, so it matches any merchant with those four letters anywhere
 *    in it — a restaurant with sage in its name, but also "Sagebrush",
 *    which is a bar, a salon and a cinema. Same hazard CLAUDE.md already
 *    records for "ulta" inside "consultant" and "rei" inside "reinvestment".
 *    Any rule whose value is exactly "sage" is DISABLED here, not deleted, so
 *    the change is visible and reversible.
 * 3. WRONG CATEGORY. Mr Sage is a grocery shop, not a restaurant.
 *
 * The SimpleFIN charge is keyed on `simplefin` and NOT on `link.com`
 * deliberately: "LINK.COM*" is a payment-rail prefix of exactly the shape
 * normalizeMerchant already strips for Toast and Square, so a rule on the rail
 * would break the day that prefix is added to the strip list.
 *
 *   npx tsx scripts/fix-sage-simplefin-rules.ts
 *   npx tsx scripts/fix-sage-simplefin-rules.ts --apply
 */
import { prisma } from '../src/lib/prisma';
import { reapplyRules } from '../src/lib/sync/rulePack';
import { generateInsights } from '../src/lib/insights/engine';
import { databaseLabel } from './database-label';

const SAGE_VALUE = 'mr sage';
const SAGE_CATEGORY = 'Groceries';
const SIMPLEFIN_VALUE = 'simplefin';
const SIMPLEFIN_CATEGORY = 'Subscriptions';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`\nDatabase: ${databaseLabel()}`);
  console.log(apply ? 'Mode: APPLY\n' : 'Mode: DRY RUN (pass --apply to write)\n');

  const groceries = await prisma.category.findFirst({ where: { name: SAGE_CATEGORY } });
  const subscriptions = await prisma.category.findFirst({ where: { name: SIMPLEFIN_CATEGORY } });
  if (groceries === null || subscriptions === null) {
    console.error(`Missing category ${SAGE_CATEGORY} or ${SIMPLEFIN_CATEGORY} — aborting.`);
    process.exitCode = 1;
    return;
  }

  // Everything sage-shaped, so no rule hides behind the one being fixed.
  const sageRules = (await prisma.rule.findMany({ orderBy: { priority: 'asc' } })).filter((r) =>
    r.matchValue.toLowerCase().includes('sage'),
  );
  console.log(`Rules mentioning "sage": ${sageRules.length}`);
  for (const r of sageRules) {
    console.log(`   p${r.priority} ${r.matchField} ${r.matchOperator} "${r.matchValue}" enabled=${r.enabled}`);
  }

  // 1 + 3: the real rule, pointed at the right field and the right category.
  const target = sageRules.find((r) => r.matchValue.toLowerCase() === SAGE_VALUE);
  if (target === undefined) {
    console.log(`\n1. No rule with matchValue "${SAGE_VALUE}" — creating one.`);
    if (apply) {
      await prisma.rule.create({
        data: {
          priority: 50,
          matchField: 'DESCRIPTION',
          matchOperator: 'CONTAINS',
          matchValue: SAGE_VALUE,
          setCategoryId: groceries.id,
          enabled: true,
        },
      });
    }
  } else {
    const fieldOk = target.matchField === 'DESCRIPTION';
    const catOk = target.setCategoryId === groceries.id;
    console.log(
      `\n1. p${target.priority} "${target.matchValue}": field ${target.matchField}${fieldOk ? ' (ok)' : ' -> DESCRIPTION'}, category ${catOk ? 'already ' + SAGE_CATEGORY : '-> ' + SAGE_CATEGORY}`,
    );
    if (apply && (!fieldOk || !catOk)) {
      await prisma.rule.update({
        where: { id: target.id },
        data: { matchField: 'DESCRIPTION', setCategoryId: groceries.id, enabled: true },
      });
    }
  }

  // 2: the over-broad one, if the UI's merchant-derived rule was used.
  const bare = sageRules.filter((r) => r.matchValue.trim().toLowerCase() === 'sage' && r.enabled);
  if (bare.length === 0) {
    console.log('\n2. No bare "sage" rule — nothing over-broad to disable.');
  } else {
    for (const r of bare) {
      console.log(`\n2. DISABLE p${r.priority} ${r.matchField} CONTAINS "sage" — matches "sagebrush" and any restaurant with sage in its name`);
      if (apply) await prisma.rule.update({ where: { id: r.id }, data: { enabled: false } });
    }
  }

  // A MANUAL category outranks every rule, so a row hand-set while the rule was
  // wrong would keep the wrong answer forever. Only Mr Sage's own rows, and
  // each one is named before it is touched.
  const manual = await prisma.transaction.findMany({
    where: { categorySource: 'MANUAL', description: { contains: SAGE_VALUE } },
    select: { id: true, date: true, amount: true, description: true },
  });
  console.log(`\n3. MANUAL rows blocking the rule: ${manual.length}`);
  for (const m of manual) {
    console.log(`   ${m.date.toISOString().slice(0, 10)} ${m.amount} ${m.description} -> released to the rule`);
    if (apply) {
      await prisma.transaction.update({
        where: { id: m.id },
        data: { categoryId: null, categorySource: 'AGGREGATOR' },
      });
    }
  }

  // SimpleFIN's own subscription.
  const simplefin = await prisma.rule.findFirst({
    where: { matchValue: SIMPLEFIN_VALUE, matchField: 'DESCRIPTION', matchOperator: 'CONTAINS' },
  });
  if (simplefin !== null) {
    console.log(`\n4. Rule DESCRIPTION CONTAINS "${SIMPLEFIN_VALUE}" already exists — skipping.`);
  } else {
    console.log(`\n4. CREATE p50 DESCRIPTION CONTAINS "${SIMPLEFIN_VALUE}" -> ${SIMPLEFIN_CATEGORY}`);
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
    }
  }

  if (!apply) {
    console.log('\nDry run — nothing written.');
    return;
  }

  const { changed } = await reapplyRules(prisma);
  console.log(`\nreapplyRules: ${changed} row(s) rewritten`);

  const cats = await prisma.category.findMany();
  const byId = new Map(cats.map((c) => [c.id, c.name]));
  const sageRows = await prisma.transaction.findMany({
    where: { description: { contains: SAGE_VALUE } },
    select: { date: true, amount: true, categoryId: true, categorySource: true },
    orderBy: { date: 'desc' },
  });
  console.log('Mr Sage rows now:');
  for (const k of sageRows) {
    console.log(`   ${k.date.toISOString().slice(0, 10)} ${String(k.amount).padStart(9)}  ${byId.get(k.categoryId ?? '') ?? 'UNCATEGORIZED'} / ${k.categorySource}`);
  }

  const left = await prisma.transaction.count({
    where: { categoryId: null, flow: { not: 'TRANSFER' }, reimbursesId: null },
  });
  console.log(`Uncategorized: ${left}`);

  const insights = await generateInsights(prisma, { granularity: 'MONTH' });
  console.log(`Insights regenerated: ${insights.created} across ${insights.periods.length} periods`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
