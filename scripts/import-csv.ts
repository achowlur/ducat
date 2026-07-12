import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CsvConnector } from '../src/lib/connectors/csv';
import { CSV_MAPPINGS } from '../src/lib/connectors/csvMappings';
import { runSync } from '../src/lib/sync/sync';
import { prisma } from '../src/lib/prisma';
import type { AccountType } from '../src/types/contracts';

/**
 * Usage:
 *   npm run import:csv -- <file.csv> --mapping=<id> --name=<account name> \
 *     --type=DEPOSITORY|CREDIT|INVESTMENT|LOAN --institution=<bank> \
 *     [--external-id=<stable id>] [--currency=USD]
 *
 * Mappings: chase-checking | chase-credit | wells-fargo | fidelity
 *
 * --external-id identifies the account across imports: reuse the same value
 * when importing newer exports of the same account so transactions dedupe
 * into it (defaults to a slug of institution + name).
 */
function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

const ACCOUNT_TYPES: AccountType[] = ['DEPOSITORY', 'CREDIT', 'INVESTMENT', 'LOAN'];

async function main(): Promise<void> {
  const file = process.argv[2];
  const mappingId = arg('mapping');
  const name = arg('name');
  const type = arg('type')?.toUpperCase() as AccountType | undefined;
  const institution = arg('institution');

  if (file === undefined || file.startsWith('--') || mappingId === undefined || name === undefined || type === undefined || institution === undefined) {
    console.error('Usage: npm run import:csv -- <file.csv> --mapping=<id> --name=<name> --type=<type> --institution=<bank>');
    console.error(`Mappings: ${Object.keys(CSV_MAPPINGS).join(' | ')}`);
    console.error(`Types: ${ACCOUNT_TYPES.join(' | ')}`);
    process.exit(1);
  }
  const mapping = CSV_MAPPINGS[mappingId];
  if (mapping === undefined) {
    console.error(`Unknown mapping "${mappingId}". Available: ${Object.keys(CSV_MAPPINGS).join(', ')}`);
    process.exit(1);
  }
  if (!ACCOUNT_TYPES.includes(type)) {
    console.error(`Unknown account type "${type}". Use: ${ACCOUNT_TYPES.join(', ')}`);
    process.exit(1);
  }

  const externalId = arg('external-id')
    ?? `${institution} ${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const connector = new CsvConnector(readFileSync(file, 'utf8'), mapping, {
    externalId,
    name,
    institution,
    type,
    currency: arg('currency'),
  });
  // CSV files contain their full history; import all of it.
  const result = await runSync(prisma, connector, { since: new Date(0) });

  console.log(`Imported ${basename(file)} (mapping: ${mapping.id}, account: ${externalId})`);
  console.log(`  Accounts: ${result.accountsCreated} created, ${result.accountsUpdated} updated`);
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
