/**
 * Point existing rules at a different category, then re-apply them.
 *
 * Exists because CODE ships through git and DATA does not. A rule retargeted on
 * the laptop leaves the cloud instance — the one actually being read — saying
 * the old thing, and nothing about a green deploy hints otherwise. So this runs
 * against whatever `DATABASE_URL` is set, prints WHICH database it is about to
 * touch before doing anything, and has to be run once per instance.
 *
 * Dry run by default; `--apply` writes and regenerates insights, so it cannot
 * leave categories and insight rows disagreeing.
 *
 *   npm run rules:retarget -- --match=zego,paylease --category="Rent & Housing"
 *   npm run rules:retarget -- --match=zego,paylease --category="Rent & Housing" --apply
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

  if (matches.length === 0 || categoryName === null) {
    console.error(
      'Usage: npm run rules:retarget -- --match=<value,value> --category="<Category Name>" [--apply]',
    );
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL ?? 'file:./data/ducat.db';
  const where = url.startsWith('libsql://') ? `CLOUD — ${new URL(url).host}` : `LOCAL — ${url}`;
  console.log(`\nDatabase: ${where}`);

  const category = await prisma.category.findFirst({ where: { name: categoryName } });
  if (category === null) {
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

  console.log(`\nRules to retarget (${rules.length}):`);
  for (const r of rules) {
    const from = r.setCategory?.name ?? (r.setFlow ?? 'null');
    console.log(`  p${r.priority} ${r.matchField} ${r.matchOperator} "${r.matchValue}" → ${from}  ⇒  ${category.name}`);
  }

  const already = rules.filter((r) => r.setCategory?.name === category.name).length;
  if (already === rules.length) {
    console.log(`\nAll ${rules.length} already point at ${category.name} — nothing to do.`);
    return;
  }

  if (!apply) {
    console.log('\nDry run. Re-run with `--apply` to write.\n');
    return;
  }

  await prisma.rule.updateMany({
    where: { id: { in: rules.map((r) => r.id) } },
    data: { setCategoryId: category.id, setFlow: null, enabled: true },
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
