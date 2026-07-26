/**
 * One-time repair for text imported before the connectors stripped U+FFFD.
 *
 *   npm run repair:text            # dry run — lists what would change
 *   npm run repair:text -- --apply # writes
 *
 * U+FFFD ("�") is the marker for a byte that could not be decoded; it carries
 * no information, so removing it loses nothing. The connectors now strip it on
 * the way in, and a sync rewrites account names — but it does NOT rewrite the
 * description of a transaction already imported, which is why this exists.
 */
import 'dotenv/config';
import { sanitizeBankText } from '../src/lib/connectors/normalize';
import { prisma } from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const accounts = await prisma.account.findMany({ select: { id: true, name: true, institution: true } });
  const txns = await prisma.transaction.findMany({ select: { id: true, description: true } });

  const accountFixes = accounts
    .map((a) => ({ id: a.id, name: sanitizeBankText(a.name), institution: sanitizeBankText(a.institution), was: a }))
    .filter((f) => f.name !== f.was.name || f.institution !== f.was.institution);
  const txnFixes = txns
    .map((t) => ({ id: t.id, description: sanitizeBankText(t.description), was: t.description }))
    .filter((f) => f.description !== f.was);

  console.log(`Accounts to repair:     ${accountFixes.length} of ${accounts.length}`);
  for (const f of accountFixes) console.log(`  ${f.was.name}  ->  ${f.name}`);
  console.log(`Transactions to repair: ${txnFixes.length} of ${txns.length}`);
  for (const f of txnFixes.slice(0, 10)) console.log(`  ${f.was}  ->  ${f.description}`);
  if (txnFixes.length > 10) console.log(`  … and ${txnFixes.length - 10} more`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with `-- --apply` to write these changes.');
    return;
  }
  for (const f of accountFixes) {
    await prisma.account.update({ where: { id: f.id }, data: { name: f.name, institution: f.institution } });
  }
  for (const f of txnFixes) {
    await prisma.transaction.update({ where: { id: f.id }, data: { description: f.description } });
  }
  console.log(`\nRepaired ${accountFixes.length} accounts and ${txnFixes.length} transactions.`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
