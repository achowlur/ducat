import 'dotenv/config';
import { SimplefinConnector } from '../src/lib/connectors/simplefin';
import { runSync } from '../src/lib/sync/sync';
import { prisma } from '../src/lib/prisma';
import type { PeriodGranularity } from '../src/types/contracts';
import { arg } from './args';
import { printDatabase } from './database-label';

/**
 * Usage: npm run sync:simplefin [-- --since=YYYY-MM-DD] [-- --granularity=MONTH]
 * Requires SIMPLEFIN_ACCESS_URL in .env.
 */
async function main(): Promise<void> {
  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  if (accessUrl === undefined || accessUrl === '') {
    console.error('SIMPLEFIN_ACCESS_URL is not set in .env.');
    console.error('  - To try the public demo feed: SIMPLEFIN_ACCESS_URL="https://demo:demo@beta-bridge.simplefin.org/simplefin"');
    console.error('  - To connect your real accounts: npm run simplefin:claim -- <setup-token>');
    process.exit(1);
  }

  const sinceArg = arg('since');
  const since = sinceArg === undefined ? undefined : new Date(`${sinceArg}T00:00:00Z`);
  if (since !== undefined && Number.isNaN(since.getTime())) {
    console.error(`Invalid --since date: ${sinceArg} (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  const granularity = arg('granularity')?.toUpperCase() as PeriodGranularity | undefined;

  // Before the network call, not after: a sync pointed at the wrong database
  // should be obvious while it is still running, not once it has written.
  printDatabase();

  const connector = new SimplefinConnector(accessUrl);
  const result = await runSync(prisma, connector, { since, granularity });

  console.log(`Synced SIMPLEFIN (since ${result.since.toISOString().slice(0, 10)})`);
  console.log(`  Accounts: ${result.accountsCreated} created, ${result.accountsUpdated} updated`);
  console.log(`  Snapshots written: ${result.snapshotsWritten}`);
  console.log(`  Transactions: ${result.transactionsImported} imported, ${result.transactionsSkipped} already present`);
  console.log(`  Rules applied: ${result.rulesApplied}, transfers linked: ${result.transfersLinked}`);
  if (result.insights !== null) {
    console.log(`  Insights regenerated: ${result.insights.created} across ${result.insights.periods.length} periods`);
  }
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
