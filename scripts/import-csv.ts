import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { CsvConnector, type CsvAccountDescriptor, type CsvAccountResolver } from '../src/lib/connectors/csv';
import { CSV_MAPPINGS } from '../src/lib/connectors/csvMappings';
import { matchAccount } from '../src/lib/connectors/matchAccount';
import { previewImport, type ImportPreview } from '../src/lib/sync/previewImport';
import { runSync } from '../src/lib/sync/sync';
import { prisma } from '../src/lib/prisma';
import { ACCOUNT_TYPES, type AccountType } from '../src/types/contracts';
import { arg, hasFlag } from './args';
import { printDatabase } from './database-label';

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
 * Mappings: chase-checking | chase-credit | wells-fargo | wells-fargo-headerless | fidelity
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
 *
 * --dry-run reports what the import would do and writes nothing. There is no
 * undo for an import — a re-downloaded export whose text differs by one
 * character re-imports rather than dedupes, and nothing records which file
 * produced which rows — so the preview is how a backfill is checked before it
 * is committed to, against the cloud database it will actually land in.
 */

/**
 * ISO date-only, deliberately: it is the form `--until` is typed in, so a
 * reader can copy one back out of this report. shortDate/monthLabel are for the
 * pages, where the reader is not about to retype what they see.
 */
function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The file-level facts, printed identically in both modes: they come from
 * PARSING, and the connector has already counted them before either path runs.
 */
function reportFile(
  connector: CsvConnector,
  resolved: Map<string, string>,
  multiAccount: boolean,
  untilArg: string | undefined,
): void {
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
  if (untilArg !== undefined) {
    console.log(`  Capped: rows on/after ${untilArg} skipped (backfill behind a live feed)`);
  }
}

function reportPreview(
  preview: ImportPreview,
  connector: CsvConnector,
  untilArg: string | undefined,
): void {
  const capped = connector.parsedRows - preview.mappedRows;
  console.log(
    capped > 0
      ? `  Parsed ${connector.parsedRows} row(s); the cap removes ${capped}, leaving ${preview.mappedRows}`
      : `  Parsed ${connector.parsedRows} row(s)`,
  );

  console.log('\n  Accounts');
  for (const a of preview.accounts) {
    const owner = a.ownedBy === null ? '' : ` (owned by ${a.ownedBy})`;
    console.log(`    ${a.disposition.padEnd(7)} ${a.name} — ${a.institution}${owner}`);
    const span =
      a.firstDate === null || a.lastDate === null
        ? 'no rows'
        : `${day(a.firstDate)} → ${day(a.lastDate)}`;
    console.log(
      `            ${a.rows} row(s), ${span}; ${a.newRows} new, ${a.duplicateRows} already present`,
    );
    const b = a.balance;
    if (!b.writes || b.value === null || b.date === null) {
      const why = untilArg !== undefined ? 'capped import' : 'this export carries no running balance';
      console.log(`            balance: not written (${why}), and no snapshot either`);
    } else {
      const writing = `${b.value.toFixed(2)} dated ${day(b.date)}`;
      if (b.currentValue === null || b.currentDate === null) {
        console.log(`            balance: ${writing}`);
      } else if (b.currentValue === b.value && b.currentDate.getTime() === b.date.getTime()) {
        // The upsert still runs; saying it REPLACES itself is noise.
        console.log(`            balance: ${writing} (unchanged)`);
      } else {
        console.log(
          `            balance: ${writing} REPLACES ${b.currentValue.toFixed(2)} dated ${day(b.currentDate)}`,
        );
      }
    }
    if (b.movesBackward) {
      console.log('            WARNING: that dates the balance EARLIER than the one already stored.');
      console.log('            Cap the import with --until unless this file really is the newer one.');
    }
  }

  console.log('');
  if (preview.newRows === 0) {
    console.log('  Nothing new: every row this file offers is already present.');
  } else {
    console.log(
      `  Transactions: ${preview.newRows} would be imported, ${preview.duplicateRows} already present`,
    );
    console.log(
      `  Rules: ${preview.rulesApplied} would fire (${preview.categorized} giving a category);` +
        ` ${preview.reviewRows} row(s) left for review`,
    );
    console.log(
      `  Review queue: ${preview.decisions.length} payee decision(s),` +
        ` ${preview.decisionsJoiningExisting} joining a group already waiting`,
    );
    const largest = preview.decisions.slice(0, 5).map((d) => `${d.key} (${d.count})`);
    if (largest.length > 0) console.log(`    Largest: ${largest.join(', ')}`);
    console.log(
      `  Merchant strings: ${preview.merchants.distinct} distinct,` +
        ` ${preview.merchants.unseen} new to this database,` +
        ` ${preview.merchants.unseenSingletons} of those on one row only`,
    );
  }

  console.log('\n  NOT previewed: transfer-pair linking and insight regeneration. Both still run,');
  console.log('  over rows this import has not written, so neither can be counted from here.');
  if (preview.newRows > 0) {
    console.log('  The payee count above is an upper bound for the same reason — every pair');
    console.log('  linked takes two more rows out of that queue.');
  }
  console.log('\nDry run — nothing was written. Re-run without --dry-run to import.');
}

async function main(): Promise<void> {
  // Before anything is read or written. This one imports rows that can never be
  // deduped away afterwards — a CSV id is a content hash, so the same file run
  // against the wrong database does not merge with what a feed already put
  // there, it doubles it. Nothing here reports which database it landed in
  // afterwards either: the counts read identically whichever one it was.
  printDatabase();

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

  const dryRun = hasFlag('dry-run');
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
  const since = new Date(0);

  if (dryRun) {
    // The same connector object runSync would be handed, read by the same
    // lookups — so what this prints is what that call would do.
    const preview = await previewImport(prisma, connector, since);
    console.log(`DRY RUN — ${basename(file)} (mapping: ${mappingId})`);
    reportFile(connector, resolved, multiAccount, untilArg);
    reportPreview(preview, connector, untilArg);
    return;
  }

  const result = await runSync(prisma, connector, { since });

  console.log(`Imported ${basename(file)} (mapping: ${mappingId})`);
  reportFile(connector, resolved, multiAccount, untilArg);
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
