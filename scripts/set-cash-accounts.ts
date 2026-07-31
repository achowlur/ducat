import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { CASH_ACCOUNTS_KEY, readCashAccountIds } from '../src/lib/ui/liquidity';

/**
 * Which non-DEPOSITORY accounts count as spendable cash.
 *
 * A brokerage account can hold a money-market balance that is cash in every way
 * that matters for "how long does this last", while still needing to be typed
 * INVESTMENT so net worth keeps using its snapshots instead of reconstructing
 * it from transactions it does not have. Those are two different questions and
 * this answers only the first.
 *
 * Per-instance operator config, so it lives in `Setting` and has to be set once
 * per database — the same rule every other DATA change follows.
 *
 *   npm run accounts:cash
 *   npm run accounts:cash -- --add=<externalId or name fragment>
 *   npm run accounts:cash -- --remove=<externalId or name fragment>
 */
function flag(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'file:./data/ducat.db';
  console.log(`\nDatabase: ${url.startsWith('libsql://') ? `CLOUD — ${new URL(url).host}` : `LOCAL — ${url}`}\n`);

  const accounts = await prisma.account.findMany({ orderBy: { institution: 'asc' } });
  const current = await readCashAccountIds(prisma);

  const add = flag('add');
  const remove = flag('remove');
  const needle = (add ?? remove)?.toLowerCase() ?? null;

  if (needle !== null) {
    const hits = accounts.filter(
      (a) => a.externalId.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle),
    );
    if (hits.length !== 1) {
      console.error(
        hits.length === 0
          ? `No account matches "${needle}".`
          : `"${needle}" matches ${hits.length} accounts: ${hits.map((h) => h.name).join(', ')}. Be more specific.`,
      );
      process.exitCode = 1;
      return;
    }
    const target = hits[0];
    const next =
      add !== null
        ? [...new Set([...current, target.id])]
        : current.filter((id) => id !== target.id);
    await prisma.setting.upsert({
      where: { key: CASH_ACCOUNTS_KEY },
      create: { key: CASH_ACCOUNTS_KEY, value: JSON.stringify(next) },
      update: { value: JSON.stringify(next) },
    });
    console.log(`${add !== null ? 'Added' : 'Removed'}: ${target.institution} / ${target.name}\n`);
  }

  const marked = new Set(await readCashAccountIds(prisma));
  console.log('Counted as cash:');
  for (const a of accounts) {
    const isCash = a.type === 'DEPOSITORY' || marked.has(a.id);
    const why = a.type === 'DEPOSITORY' ? 'by type' : marked.has(a.id) ? 'marked' : '';
    console.log(
      `  ${isCash ? '*' : ' '} ${a.type.padEnd(11)} ${String(a.balance).padStart(12)}  ${a.name.slice(0, 38).padEnd(40)} ${why}`,
    );
  }
  const total = accounts
    .filter((a) => a.type === 'DEPOSITORY' || marked.has(a.id))
    .reduce((s, a) => s + Number(a.balance), 0);
  console.log(`\nCash total: ${total.toFixed(2)}`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
