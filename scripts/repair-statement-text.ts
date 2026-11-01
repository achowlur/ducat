import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { normalizeMerchant, sanitizeBankText } from '../src/lib/connectors/normalize';
import { readStatement } from '../src/lib/connectors/pdf/read';
import { transactionDateNote, type StatementRow } from '../src/lib/connectors/pdf/statement';
import { prisma } from '../src/lib/prisma';
import { planTextFill, type NamelessRow } from '../src/lib/sync/statementText';
import { hasFlag } from './args';
import { printDatabase } from './database-label';
import { maskLayoutText } from './layoutMask';

/**
 * Usage:
 *   npm run repair:statement-text -- <statement.pdf | folder> [more...]          # dry run
 *   npm run repair:statement-text -- <statement.pdf | folder> [more...] --apply  # writes
 *
 * Refills the description of rows a statement import stored EMPTY. An OCR'd
 * statement can lose a row's text on the way in while its date and amount,
 * which the balance check guards, came through; a later layout keeps the
 * text. Each file given is matched to the import batch it made (by its
 * bytes), read again, and every nameless row of that batch takes the text of
 * the read row with its date and amount (sync/statementText.ts: a multiset,
 * never a guess between two different texts). Nothing outside those batches
 * is touched, and a file no batch came from is skipped and said.
 *
 * The dry run prints counts, and each new text through the pdf:layout mask.
 */

function pdfFiles(paths: string[]): string[] {
  return paths.flatMap((p) =>
    statSync(p).isDirectory()
      ? readdirSync(p)
          .filter((f) => f.toLowerCase().endsWith('.pdf'))
          .sort()
          .map((f) => join(p, f))
      : [p],
  );
}

/** A row's description as the import stores it: a late-posted row carries the merchant's date. */
function described(row: StatementRow): string {
  return row.transactionDate === undefined ? row.description : `${row.description} ${transactionDateNote(row.transactionDate)}`;
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.error('Usage: npm run repair:statement-text -- <statement.pdf | folder> [more...] [--apply]');
    process.exit(1);
  }
  const apply = hasFlag('apply');
  printDatabase();

  const updates: { id: string; description: string; normalizedMerchant: string }[] = [];
  let unmatched = 0;
  let skipped = 0;
  let nameless = 0;
  for (const file of pdfFiles(paths)) {
    const bytes = readFileSync(file);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const batches = await prisma.importBatch.findMany({ where: { fileSha256: sha }, select: { id: true } });
    if (batches.length === 0) {
      skipped++;
      continue;
    }
    const rows = await prisma.transaction.findMany({
      where: { importBatchId: { in: batches.map((b) => b.id) }, description: '' },
      select: { id: true, date: true, amount: true },
    });
    if (rows.length === 0) continue;
    nameless += rows.length;
    const read = await readStatement(new Uint8Array(bytes));
    if (!read.ok) {
      console.log(`  ${basename(file)}: ${rows.length} nameless rows, but the file reads as refused now: ${read.reason}`);
      unmatched += rows.length;
      continue;
    }
    const stored: NamelessRow[] = rows.map((r) => ({ id: r.id, date: r.date, amount: Number(r.amount) }));
    const plan = planTextFill(stored, read.statements.flatMap((s) => s.rows));
    unmatched += plan.unmatched.length;
    console.log(`  ${basename(file)}: ${rows.length} nameless rows, ${plan.fills.length} named, ${plan.unmatched.length} left`);
    for (const f of plan.fills) {
      const description = sanitizeBankText(described({ description: f.description, date: new Date(0), amount: 0 }));
      updates.push({
        id: f.id,
        description,
        normalizedMerchant: normalizeMerchant(sanitizeBankText(f.merchantText ?? f.description)),
      });
      console.log(`    ${maskLayoutText(description)}`);
    }
  }

  console.log(`\n${nameless} nameless rows across the files given; ${updates.length} to name, ${unmatched} left as they are; ${skipped} file(s) no import came from.`);
  if (!apply) {
    console.log('Dry run. Re-run with `-- --apply` to write these.');
    return;
  }
  for (const u of updates) {
    await prisma.transaction.update({ where: { id: u.id }, data: { description: u.description, normalizedMerchant: u.normalizedMerchant } });
  }
  console.log(`Named ${updates.length} rows.`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
