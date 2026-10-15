import { extractLines } from './extract';
import { LAYOUTS } from './layouts';
import { reconcile, settleLatePostings, type ParsedStatement, type StatementLayout } from './statement';

export type ReadResult = { ok: true; statements: ParsedStatement[] } | { ok: false; reason: string };

/**
 * One PDF file to its reconciled statements (one per account it covers), or
 * the reason it was refused. A file is imported entirely or not at all: if
 * any account in it fails its checks, none of them is imported.
 */
export async function readStatement(bytes: Uint8Array, layouts: StatementLayout[] = LAYOUTS): Promise<ReadResult> {
  const lines = await extractLines(bytes);
  if (lines.length === 0) {
    return { ok: false, reason: 'no text layer, so it is a scan (there is no OCR here)' };
  }
  const layout = layouts.find((l) => l.detect(lines));
  if (layout === undefined) {
    return { ok: false, reason: 'not a statement layout this import reads (npm run pdf:layout prints it, to add one)' };
  }
  let statements: ParsedStatement[];
  try {
    statements = layout.parse(lines);
  } catch (e) {
    return { ok: false, reason: `${layout.id}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (statements.length === 0) {
    return { ok: false, reason: `${layout.id}: no account in it could be read` };
  }
  for (const statement of statements) {
    const problems = reconcile(statement);
    if (problems.length > 0) {
      const which = statements.length > 1 ? ` (account ending ${statement.accountLast4})` : '';
      return { ok: false, reason: `${layout.id}${which} does not add up: ${problems.join('; ')}` };
    }
  }
  return { ok: true, statements: statements.map(settleLatePostings) };
}
