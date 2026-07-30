/**
 * Edit existing rules in place — category, match field, or match operator —
 * then re-apply them.
 *
 * Exists because CODE ships through git and DATA does not. A rule retargeted on
 * the laptop leaves the cloud instance — the one actually being read — saying
 * the old thing, and nothing about a green deploy hints otherwise. So this runs
 * against whatever `DATABASE_URL` is set, prints WHICH database it is about to
 * touch before doing anything, and has to be run once per instance.
 *
 * It grew past `--category` because the two rule defects found since are both
 * about SHAPE rather than target: a rule matching MERCHANT that should have
 * matched DESCRIPTION (the merchant string differs by source), and a CONTAINS
 * that should have been EQUALS (the value is the whole merchant). Each was
 * fixed by its own throwaway script before this covered them, which is one
 * throwaway script too many.
 *
 * Dry run by default; `--apply` writes and regenerates insights, so it cannot
 * leave categories and insight rows disagreeing.
 *
 *   npm run rules:retarget -- --match=zego,paylease --category="Rent & Housing"
 *   npm run rules:retarget -- --match=bucks --operator=EQUALS --apply
 *   npm run rules:retarget -- --match="mr sage" --field=DESCRIPTION --apply
 */
import { prisma } from '../src/lib/prisma';
import { reapplyRules } from '../src/lib/sync/rulePack';
import { generateInsights } from '../src/lib/insights/engine';

function flag(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const matches = (flag('match') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
  const categoryName = flag('category');
  const newField = flag('field')?.toUpperCase() ?? null;
  const newOperator = flag('operator')?.toUpperCase() ?? null;

  const FIELDS = ['MERCHANT', 'DESCRIPTION', 'AMOUNT', 'ACCOUNT'];
  const OPERATORS = ['CONTAINS', 'EQUALS', 'REGEX', 'GT', 'LT'];

  if (matches.length === 0 || (categoryName === null && newField === null && newOperator === null)) {
    console.error(
      'Usage: npm run rules:retarget -- --match=<value,value> [--category="<Name>"] [--field=<FIELD>] [--operator=<OP>] [--apply]',
    );
    console.error('At least one of --category, --field or --operator is required.');
    process.exitCode = 1;
    return;
  }
  if (newField !== null && !FIELDS.includes(newField)) {
    console.error(`Unknown --field "${newField}". One of: ${FIELDS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (newOperator !== null && !OPERATORS.includes(newOperator)) {
    console.error(`Unknown --operator "${newOperator}". One of: ${OPERATORS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL ?? 'file:./data/ducat.db';
  const where = url.startsWith('libsql://') ? `CLOUD — ${new URL(url).host}` : `LOCAL — ${url}`;
  console.log(`\nDatabase: ${where}`);

  const category =
    categoryName === null ? null : await prisma.category.findFirst({ where: { name: categoryName } });
  if (categoryName !== null && category === null) {
    const all = await prisma.category.findMany({ orderBy: { name: 'asc' }, select: { name: true } });
    console.error(`\nNo category named "${categoryName}". Available: ${all.map((c) => c.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const rules = await prisma.rule.findMany({
    where: { matchValue: { in: matches } },
    select: {
      id: true,
      priority: true,
      matchField: true,
      matchOperator: true,
      matchValue: true,
      setFlow: true,
      setCategory: { select: { name: true } },
    },
    orderBy: { priority: 'asc' },
  });

  if (rules.length === 0) {
    console.log(`\nNo rules match ${matches.map((m) => `"${m}"`).join(' or ')} — nothing to do.`);
    return;
  }

  console.log(`\nRules to edit (${rules.length}):`);
  for (const r of rules) {
    const from = r.setCategory?.name ?? (r.setFlow ?? 'null');
    const to = [
      newField !== null && newField !== r.matchField ? `field ${r.matchField} → ${newField}` : null,
      newOperator !== null && newOperator !== r.matchOperator
        ? `operator ${r.matchOperator} → ${newOperator}`
        : null,
      category !== null && r.setCategory?.name !== category.name ? `category ${from} → ${category.name}` : null,
    ].filter((s) => s !== null);
    console.log(
      `  p${r.priority} ${r.matchField} ${r.matchOperator} "${r.matchValue}" → ${from}` +
        (to.length === 0 ? '   (already as requested)' : `\n     ⇒  ${to.join(', ')}`),
    );
  }

  const unchanged = rules.filter(
    (r) =>
      (category === null || r.setCategory?.name === category.name) &&
      (newField === null || r.matchField === newField) &&
      (newOperator === null || r.matchOperator === newOperator),
  ).length;
  if (unchanged === rules.length) {
    console.log(`\nAll ${rules.length} are already as requested — nothing to do.`);
    return;
  }

  if (!apply) {
    console.log('\nDry run. Re-run with `--apply` to write.\n');
    return;
  }

  // Only what was asked for. Retargeting a category clears setFlow, because a
  // rule cannot both categorize and mark TRANSFER; changing only the shape of
  // the match must leave the target alone.
  await prisma.rule.updateMany({
    where: { id: { in: rules.map((r) => r.id) } },
    data: {
      ...(category === null ? {} : { setCategoryId: category.id, setFlow: null }),
      ...(newField === null ? {} : { matchField: newField as 'MERCHANT' }),
      ...(newOperator === null ? {} : { matchOperator: newOperator as 'CONTAINS' }),
      enabled: true,
    },
  });
  const { changed } = await reapplyRules(prisma);
  console.log(`\nApplied. reapplyRules rewrote ${changed} transaction(s) (MANUAL rows are never touched).`);

  // Regenerated here rather than left to a second command: categories and
  // insight rows disagreeing is exactly the split-brain this script exists to
  // stop, and one of the two databases silently keeping stale totals is how it
  // would show up.
  const result = await generateInsights(prisma);
  console.log(`Regenerated ${result.created} insight(s) across ${result.periods.length} period(s).\n`);
}

main().finally(() => prisma.$disconnect());
