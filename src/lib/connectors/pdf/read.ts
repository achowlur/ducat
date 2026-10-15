import { extractLines } from './extract';
import { LAYOUTS } from './layouts';
import { reconcile, settleLatePostings, type ParsedStatement, type StatementLayout } from './statement';

export type ReadResult = { ok: true; statement: ParsedStatement } | { ok: false; reason: string };

/**
 * One PDF file to a reconciled statement, or the reason it was refused.
 * Every refusal is whole-file: a statement is imported entirely or not at all.
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
  let statement: ParsedStatement;
  try {
    statement = layout.parse(lines);
  } catch (e) {
    return { ok: false, reason: `${layout.id}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const problems = reconcile(statement);
  if (problems.length > 0) {
    return { ok: false, reason: `${layout.id} does not add up: ${problems.join('; ')}` };
  }
  return { ok: true, statement: settleLatePostings(statement) };
}
