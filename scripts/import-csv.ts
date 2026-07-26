import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CsvConnector, type CsvAccountDescriptor, type CsvAccountResolver } from '../src/lib/connectors/csv';
import { CSV_MAPPINGS } from '../src/lib/connectors/csvMappings';
import { matchAccount } from '../src/lib/connectors/matchAccount';
import { runSync } from '../src/lib/sync/sync';
import { prisma } from '../src/lib/prisma';
import { ACCOUNT_TYPES, type AccountType } from '../src/types/contracts';
import { arg } from './args';

/**
 * Usage (single account):
 *   npm run import:csv -- <file.csv> --mapping=<id> --name=<account name> \
 *     --type=DEPOSITORY|CREDIT|INVESTMENT|LOAN --institution=<bank> \
 *     [--external-id=<stable id>] [--currency=USD] [--until=YYYY-MM-DD]
 *
 * Usage (one file holding several accounts, e.g. a Fidelity combined export):
 *   npm run import:csv -- <file.csv> --mapping=fidelity [--until=YYYY-MM-DD] \
 *     [--account-column="Account Number"]
 *   Omit --external-id and each row is routed to an EXISTING account by
 *   matching the file's account number against known account names. Rows that
 *   don't match any account are skipped and reported — never guessed at.
 *
 * Mappings: chase-checking | chase-credit | wells-fargo | fidelity
 *
 * --external-id identifies the account across imports: reuse the same value
 * when importing newer exports of the same account so transactions dedupe
 * into it (defaults to a slug of institution + name). To backfill history into
 * an account a live connector already owns, pass THAT account's externalId.
 *
 * --until caps the import (exclusive). Dedupe is (accountId, externalId), and
 * a CSV row's id is a content hash while an aggregator's is the feed's id — so
 * the same transaction from both sources will NOT dedupe. When backfilling
 * behind a live feed, set --until to the date that feed's coverage starts.
 */

async function main(): Promise<void> {
  const file = process.argv[2];
  const mappingId = arg('mapping');
  if (file === undefined || file.startsWith('--') || mappingId === undefined) {
    console.error('Usage: npm run import:csv -- <file.csv> --mapping=<id> [--name=... --type=... --institution=...]');
    console.error(`Mappings: ${Object.keys(CSV_MAPPINGS).join(' | ')}`);
    process.exit(1);
  }
  const baseMapping = CSV_MAPPINGS[mappingId];
  if (baseMapping === undefined) {
    console.error(`Unknown mapping "${mappingId}". Available: ${Object.keys(CSV_MAPPINGS).join(', ')}`);
    process.exit(1);
  }

  const untilArg = arg('until');
  const until = untilArg === undefined ? undefined : new Date(`${untilArg}T00:00:00Z`);
  if (until !== undefined && Number.isNaN(until.getTime())) {
    console.error(`Invalid --until date: ${untilArg} (expected YYYY-MM-DD)`);
    process.exit(1);
  }

  // Explicit --external-id means "this whole file is that one account", even
  // for a mapping that supports multi-account files.
  const explicitExternalId = arg('external-id');
  const accountColumn = arg('account-column') ?? baseMapping.account;
  const multiAccount = explicitExternalId === undefined && accountColumn !== undefined;
  const mapping = multiAccount
    ? { ...baseMapping, account: accountColumn }
    : { ...baseMapping, account: undefined };

  let account: CsvAccountDescriptor | CsvAccountResolver;
  const resolved = new Map<string, string>();

  if (multiAccount) {
    const known = await prisma.account.findMany({
      select: { externalId: true, name: true, institution: true, type: true, currency: true },
    });
    if (known.length === 0) {
      console.error('Multi-account import needs existing accounts to route rows into.');
      console.error('Sync a connector first, or import per-account with --external-id/--name/--type/--institution.');
      process.exit(1);
    }
    const cache = new Map<string, CsvAccountDescriptor | null>();
    account = (raw: string): CsvAccountDescriptor | null => {
      const cached = cache.get(raw);
      if (cached !== undefined) return cached;
      const match = matchAccount(raw, known);
      const descriptor: CsvAccountDescriptor | null =
        match === null
          ? null
          : {
              externalId: match.externalId,
              name: match.name,
              institution: match.institution,
              type: match.type as AccountType,
              currency: match.currency,
              until,
            };
      if (match !== null) resolved.set(raw, match.name);
      cache.set(raw, descriptor);
      return descriptor;
    };
  } else {
    const name = arg('name');
    const type = arg('type')?.toUpperCase() as AccountType | undefined;
    const institution = arg('institution');
    if (name === undefined || type === undefined || institution === undefined) {
      console.error('Single-account import requires --name, --type and --institution.');
      console.error(`Types: ${ACCOUNT_TYPES.join(' | ')}`);
      process.exit(1);
    }
    if (!ACCOUNT_TYPES.includes(type)) {
      console.error(`Unknown account type "${type}". Use: ${ACCOUNT_TYPES.join(', ')}`);
      process.exit(1);
    }
    account = {
      externalId:
        explicitExternalId ?? `${institution} ${name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name,
      institution,
      type,
      currency: arg('currency'),
      until,
    };
  }

  const connector = new CsvConnector(readFileSync(file, 'utf8'), mapping, account);
  // CSV files contain their full history; import all of it.
  const result = await runSync(prisma, connector, { since: new Date(0) });

  console.log(`Imported ${basename(file)} (mapping: ${mappingId})`);
  if (multiAccount) {
    console.log(`  Routed to ${resolved.size} account(s):`);
    for (const [raw, name] of resolved) console.log(`    ${raw} → ${name}`);
  }
  if (connector.unresolvedAccounts.size > 0) {
    console.log('  SKIPPED — no matching account (nothing was guessed):');
    for (const [raw, count] of connector.unresolvedAccounts) {
      console.log(`    ${raw === '' ? '(blank)' : raw}: ${count} row(s)`);
    }
  }
  if (connector.skippedRows > 0) {
    console.log(`  Pending rows skipped: ${connector.skippedRows} (they change or vanish before posting)`);
  }
  if (until !== undefined) {
    console.log(`  Capped: rows on/after ${untilArg} skipped (backfill behind a live feed)`);
  }
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
