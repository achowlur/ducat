import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseCsv } from '../src/lib/connectors/csvParser';
import { matchAccount } from '../src/lib/connectors/matchAccount';
import { generateInsights } from '../src/lib/insights/engine';
import { prisma } from '../src/lib/prisma';
import { arg } from './args';
import { databaseLabel } from './database-label';

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
 * Usage:
 *   npm run import:balances -- --template [--months=24] > balances.csv
 *   npm run import:balances -- balances.csv [--dry-run]
 */
function column(header: string[], ...names: string[]): number {
  for (const name of names) {
    const idx = header.indexOf(name);
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Accepts YYYY-MM-DD (what the template emits) and M/D/YYYY, because opening
 * the template in Excel rewrites the dates to the local format on save and
 * every row would otherwise be rejected. Noon UTC so rendering never shifts
 * the calendar day.
 */
function parseDate(raw: string): Date | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  const [y, m, d] = iso !== null
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : mdy !== null
      ? [Number(mdy[3]), Number(mdy[1]), Number(mdy[2])]
      : [NaN, NaN, NaN];
  if (!Number.isFinite(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** Last instant-free calendar day of the month containing `d`, as YYYY-MM-DD. */
function monthEnd(year: number, month: number): string {
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}

/**
 * Emits a fill-in skeleton: one row per INVESTMENT account per month that has
 * no snapshot yet, newest first so a partial fill still buys the most useful
 * history. Only investment accounts appear — cash and credit reconstruct
 * exactly from their transactions and need nothing.
 *
 * CSV goes to stdout so it can be redirected; guidance goes to stderr.
 */
async function emitTemplate(months: number): Promise<void> {
  const accounts = await prisma.account.findMany({
    where: { type: 'INVESTMENT' },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  if (accounts.length === 0) {
    console.error('No investment accounts — cash and credit need no snapshots.');
    return;
  }

  const snapshots = await prisma.balanceSnapshot.findMany({ select: { accountId: true, date: true } });
  const covered = new Set(
    snapshots.map((s) => `${s.accountId}|${s.date.toISOString().slice(0, 7)}`),
  );

  const now = new Date();
  const rows: string[] = [];
  let skipped = 0;
  for (let back = 0; back < months; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const key = d.toISOString().slice(0, 7);
    const date = monthEnd(d.getUTCFullYear(), d.getUTCMonth());
    for (const a of accounts) {
      if (covered.has(`${a.id}|${key}`)) {
        skipped++;
        continue;
      }
      rows.push(`"${a.name}",${date},`);
    }
  }

  console.log('account,date,balance');
  for (const r of rows) console.log(r);

  console.error(`\n${rows.length} row(s) to fill; ${skipped} month(s) already have a snapshot.`);
  console.error('Fill the balance column from each statement\'s "Ending Account Value", then:');
  console.error('  npm run import:balances -- balances.csv --dry-run');
  console.error('Rows you leave blank are skipped, so fill only the months you want charted.');
  console.error('Note: net worth also needs the cash side, which reconstructs from transactions —');
  console.error('so months earlier than your oldest imported transactions stay approximate.');
}

async function main(): Promise<void> {
  // Every script that writes rows names its database first — this one was the
  // last without the label.
  console.log(`\nDatabase: ${databaseLabel()}\n`);
  const file = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');

  if (process.argv.includes('--template')) {
    const months = Number(arg('months') ?? 24);
    await emitTemplate(Number.isFinite(months) && months > 0 ? Math.floor(months) : 24);
    return;
  }

  if (file === undefined || file.startsWith('--')) {
    console.error('Usage: npm run import:balances -- <file.csv> [--dry-run]');
    console.error('   or: npm run import:balances -- --template [--months=24] > balances.csv');
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
  let blank = 0;
  for (const row of rows.slice(1)) {
    const label = (row[iAccount] ?? '').trim();
    const rawDate = (row[iDate] ?? '').trim();
    // A balance written with thousands separators but WITHOUT quotes
    // ("...,2026-06-30,517,916.57") splits into extra fields, and reading just
    // the balance column would silently store $515.75 instead of $517,916.57.
    // When balance is the final column, re-join everything from it onward.
    const balanceIsLast = iBalance === header.length - 1;
    const rawBalance = (balanceIsLast ? row.slice(iBalance).join('') : (row[iBalance] ?? ''))
      .trim()
      .replace(/[$,\s]/g, '');
    if (!balanceIsLast && (row[iBalance] ?? '').includes(',')) {
      console.log(`  SKIP  ambiguous balance "${row[iBalance]}" — quote it or remove separators`);
      skipped++;
      continue;
    }
    if (label === '' && rawDate === '' && rawBalance === '') continue;
    // An unfilled template row. Number('') is 0, which would silently record a
    // $0 balance — the one wrong value that looks plausible.
    if (rawBalance === '') {
      blank++;
      continue;
    }

    const account = matchAccount(label, accounts);
    const date = parseDate(rawDate);
    const balance = Number(rawBalance);

    if (account === null) {
      console.log(`  SKIP  no unambiguous account for "${label}"`);
      skipped++;
      continue;
    }
    if (date === null) {
      console.log(`  SKIP  unparseable date "${rawDate}" (expected YYYY-MM-DD or M/D/YYYY)`);
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
    `\n${basename(file)}: ${written} snapshot(s) ${dryRun ? 'previewed' : 'written'}, ${skipped} skipped` +
      (blank > 0 ? `, ${blank} left blank` : ''),
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
