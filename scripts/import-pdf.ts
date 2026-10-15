import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readStatement } from '../src/lib/connectors/pdf/read';
import { transactionDateNote, type StatementRow } from '../src/lib/connectors/pdf/statement';
import { previewImport } from '../src/lib/sync/previewImport';
import {
  isAdded,
  connectorFor,
  planStatementImport,
  writeStatementImport,
  type StatementFile,
  type StatementImportPlan,
} from '../src/lib/sync/statementImport';
import { prisma } from '../src/lib/prisma';
import { arg, hasFlag } from './args';
import { printDatabase } from './database-label';
import { maskFigures, maskLayoutText } from './layoutMask';

/**
 * Usage:
 *   npm run import:pdf -- <statement.pdf | folder> [more...] [--dry-run]
 *     [--external-id=<account externalId>] [--match-days=4] [--share]
 *
 * Reads bank statement PDFs into history. Each statement is read by the parser
 * for its layout and REFUSED WHOLE unless its rows add up to its own opening
 * and closing balances. It lands in the existing account whose last four
 * digits it prints (or the one --external-id names).
 *
 * A statement row the database already holds is not added again, even when it
 * came from the feed or a CSV under another id: rows match on account, amount
 * and a date within --match-days (statement and feed dates differ by a few
 * days). Inside the dates already stored, a row matching nothing is a GAP and
 * is added; one competing with others for fewer stored rows is AMBIGUOUS and
 * is never added. --dry-run lists every gap and ambiguous row and writes
 * nothing; run it first, against the database the import will land in.
 *
 * --share prints the report so it can be pasted to someone helping: counts and
 * refusal reasons stay readable with their figures masked, and every listed
 * row goes through the pdf:layout mask (scripts/layoutMask.ts), so no name,
 * merchant or amount survives.
 *
 * Each statement's closing balance is written as a snapshot dated to it, and
 * each file is recorded (name, hash, account, period) so a re-run skips it
 * and its rows can be traced to it.
 */

/** What listed rows and reasons print through; --share swaps in the masks. */
let listed = (text: string): string => text;
let reason = (text: string): string => text;

function day(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A row as it will be stored: a late-posted one carries the merchant's date. */
function described(row: StatementRow): string {
  return row.transactionDate === undefined ? row.description : `${row.description} ${transactionDateNote(row.transactionDate)}`;
}

function money(n: number): string {
  return n.toFixed(2).padStart(10);
}

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

function report(plan: StatementImportPlan, refused: { fileName: string; reason: string }[]): void {
  for (const r of refused) console.log(`  REFUSED  ${r.fileName}: ${reason(r.reason)}`);
  for (const s of plan.skipped) console.log(`  SKIPPED  ${s.fileName}: ${reason(s.reason)}`);

  let account = '';
  for (const p of plan.statements) {
    if (p.account.id !== account) {
      account = p.account.id;
      console.log(`\n  ${reason(p.account.name)} (${p.account.institution})`);
    }
    const st = p.file.statement;
    const added = p.rows.filter((r) => isAdded(r.verdict)).length;
    console.log(
      `    ${day(st.periodStart)} to ${day(st.periodEnd)}  ${String(p.rows.length).padStart(3)} rows, ${String(added).padStart(3)} to add   ${p.file.fileName}`,
    );
  }

  const all = plan.statements.flatMap((p) => p.rows.map((r) => ({ ...r, account: p.account.name })));
  const count = (kind: string) => all.filter((r) => r.verdict.kind === kind).length;
  console.log('\n  Rows');
  console.log(`    ${count('NEW')} older than anything stored (added)`);
  console.log(`    ${count('GAP')} inside the stored dates with nothing matching (added, listed below)`);
  console.log(`    ${count('MATCHED') + count('PRESENT')} already stored (${count('MATCHED')} under another source's id)`);
  console.log(`    ${count('AMBIGUOUS')} ambiguous (NOT added, listed below)`);

  const gaps = all.filter((r) => r.verdict.kind === 'GAP');
  if (gaps.length > 0) {
    console.log(`\n  Gaps: added, because nothing stored within ${plan.windowDays} days has the same amount`);
    for (const g of gaps) console.log(listed(`    ${day(g.row.date)} ${money(g.row.amount)}  ${described(g.row)}  [${g.account}]`));
  }
  const ambiguous = all.filter((r) => r.verdict.kind === 'AMBIGUOUS');
  if (ambiguous.length > 0) {
    console.log('\n  Ambiguous: rows of one amount competing for fewer stored rows; which is missing cannot be told');
    for (const a of ambiguous) console.log(listed(`    ${day(a.row.date)} ${money(a.row.amount)}  ${described(a.row)}  [${a.account}]`));
  }
  for (const [accountId, rows] of plan.storedOnly) {
    const name = plan.statements.find((p) => p.account.id === accountId)?.account.name ?? accountId;
    console.log(`\n  Stored for ${reason(name)} inside these statement periods, on no statement (${rows.length}; left as they are):`);
    for (const r of rows.slice(0, 15)) console.log(listed(`    ${day(r.date)} ${money(r.amount)}  ${r.description}`));
    if (rows.length > 15) console.log(`    ...and ${rows.length - 15} more`);
  }
  console.log(`\n  Balance snapshots: ${plan.snapshots.length} statement closing balance(s) to write`);
}

async function main(): Promise<void> {
  // Before anything is read or written: the counts read identically whichever
  // database this is, and statement rows written to the wrong one double what
  // the feed later puts there.
  printDatabase();

  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.error('Usage: npm run import:pdf -- <statement.pdf | folder> [more...] [--dry-run] [--external-id=<id>] [--match-days=4] [--share]');
    process.exit(1);
  }
  const windowDays = Number(arg('match-days') ?? '4');
  if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 10) {
    console.error('--match-days must be a whole number from 0 to 10');
    process.exit(1);
  }
  const dryRun = hasFlag('dry-run');
  if (hasFlag('share')) {
    listed = maskLayoutText;
    reason = maskFigures;
  }

  const files: StatementFile[] = [];
  const refused: { fileName: string; reason: string }[] = [];
  const found = pdfFiles(paths);
  for (const path of found) {
    const bytes = readFileSync(path);
    const result = await readStatement(bytes);
    if (!result.ok) {
      refused.push({ fileName: basename(path), reason: result.reason });
      continue;
    }
    // A brokerage report covers several accounts: one statement each.
    const fileSha256 = createHash('sha256').update(bytes).digest('hex');
    for (const statement of result.statements) files.push({ fileName: basename(path), fileSha256, statement });
  }

  const plan = await planStatementImport(prisma, files, { windowDays, externalId: arg('external-id') });
  console.log(`${dryRun ? 'DRY RUN' : 'IMPORT'}: ${found.length} file(s), ${plan.statements.length} statement(s) to import`);
  report(plan, refused);

  if (dryRun) {
    const preview = await previewImport(prisma, connectorFor(plan), new Date(0));
    if (preview.newRows > 0) {
      console.log(
        `\n  Rules: ${preview.rulesApplied} would fire (${preview.categorized} giving a category);` +
          ` ${preview.reviewRows} row(s) left for review in ${preview.decisions.length} payee decision(s)`,
      );
    }
    console.log('\n  NOT previewed: transfer-pair linking and insight regeneration; both still run on import.');
    console.log('\nDry run: nothing was written. Re-run without --dry-run to import.');
    return;
  }
  if (plan.statements.length === 0) {
    console.log('\nNothing to import.');
    return;
  }

  const result = await writeStatementImport(prisma, plan);
  console.log(`\nImported: ${result.sync.transactionsImported} row(s) added, ${result.snapshotsWritten} snapshot(s), ${result.batchesRecorded} statement(s) recorded`);
  console.log(`  Rules applied: ${result.sync.rulesApplied}, transfers linked: ${result.sync.transfersLinked}`);
  if (result.sync.insights !== null) {
    console.log(`  Insights regenerated: ${result.sync.insights.created} across ${result.sync.insights.periods.length} periods`);
  }
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
