import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseCsv } from '../src/lib/connectors/csvParser';
import { matchAccount } from '../src/lib/connectors/matchAccount';
import { generateInsights } from '../src/lib/insights/engine';
import { prisma } from '../src/lib/prisma';

/**
 * Imports month-end balances as BalanceSnapshots — the only way to get real
 * historical net worth for an INVESTMENT account.
 *
 * A brokerage's value moves with the market, which leaves no transaction, so
 * its past balance cannot be reconstructed from history (see balanceAt in
 * insights/netWorth.ts). Statements DO carry it: the "Ending Account Value" on
 * each monthly statement is exactly the missing number. Cash and credit
 * accounts reconstruct exactly from their transactions, so one snapshot per
 * investment account per month-end is enough to unlock that whole month.
 *
 * File format (header required, column order free):
 *   account,date,balance
 *   Brokerage Individual (0001),2025-08-31,467631.19
 *   RETIREMENT IRA (0002),2025-08-31,54438.11
 *
 * `account` matches an existing account by name, external id, masked account
 * number, or unambiguous substring. Rows that don't resolve are reported, never
 * guessed. Balances are signed the same way the app stores them: CREDIT and
 * LOAN balances are negative.
 *
 * Usage: npm run import:balances -- <file.csv> [--dry-run]
 */
function column(header: string[], ...names: string[]): number {
  for (const name of names) {
    const idx = header.indexOf(name);
    if (idx !== -1) return idx;
  }
  return -1;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (file === undefined || file.startsWith('--')) {
    console.error('Usage: npm run import:balances -- <file.csv> [--dry-run]');
    console.error('Columns: account,date,balance   (date = YYYY-MM-DD)');
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(file, 'utf8'));
  if (rows.length < 2) {
    console.error('File has no data rows.');
    process.exit(1);
  }
  const header = rows[0].map((c) => c.trim().toLowerCase());
  const iAccount = column(header, 'account', 'account name', 'name');
  const iDate = column(header, 'date', 'as of', 'month');
  const iBalance = column(header, 'balance', 'ending account value', 'value', 'amount');
  if (iAccount === -1 || iDate === -1 || iBalance === -1) {
    console.error(`Need account, date and balance columns. Found: ${header.join(', ')}`);
    process.exit(1);
  }

  const accounts = await prisma.account.findMany({ select: { id: true, name: true, externalId: true } });
  if (accounts.length === 0) {
    console.error('No accounts exist yet — sync or import transactions first.');
    process.exit(1);
  }

  let written = 0;
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const label = (row[iAccount] ?? '').trim();
    const rawDate = (row[iDate] ?? '').trim();
    const rawBalance = (row[iBalance] ?? '').trim().replace(/[$,]/g, '');
    if (label === '' && rawDate === '' && rawBalance === '') continue;

    const account = matchAccount(label, accounts);
    const date = new Date(`${rawDate}T12:00:00Z`);
    const balance = Number(rawBalance);

    if (account === null) {
      console.log(`  SKIP  no unambiguous account for "${label}"`);
      skipped++;
      continue;
    }
    if (Number.isNaN(date.getTime())) {
      console.log(`  SKIP  unparseable date "${rawDate}" (expected YYYY-MM-DD)`);
      skipped++;
      continue;
    }
    if (!Number.isFinite(balance)) {
      console.log(`  SKIP  unparseable balance "${rawBalance}" for ${account.name}`);
      skipped++;
      continue;
    }

    console.log(
      `  ${dryRun ? 'would set' : 'set'}  ${rawDate}  ${account.name.slice(0, 30).padEnd(30)} ${balance.toFixed(2).padStart(12)}`,
    );
    if (!dryRun) {
      await prisma.balanceSnapshot.upsert({
        where: { accountId_date: { accountId: account.id, date } },
        create: { accountId: account.id, date, balance },
        update: { balance },
      });
    }
    written++;
  }

  console.log(
    `\n${basename(file)}: ${written} snapshot(s) ${dryRun ? 'previewed' : 'written'}, ${skipped} skipped`,
  );
  if (dryRun) {
    console.log('Dry run — nothing was written. Re-run without --dry-run to apply.');
    return;
  }
  if (written > 0) {
    const regen = await generateInsights(prisma);
    console.log(`Insights regenerated: ${regen.created} across ${regen.periods.length} periods`);
  }
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
