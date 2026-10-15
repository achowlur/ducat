import { readFileSync } from 'node:fs';
import { extractLines } from '../src/lib/connectors/pdf/extract';
import { arg, hasFlag } from './args';

/**
 * Usage:
 *   npm run pdf:layout -- <statement.pdf> [--pages=1-3] [--unmasked]
 *
 * Prints a statement's text as the import reads it: one line per row of the
 * page, each cell with the x positions it starts and ends at. Writing a parser for a new
 * statement layout starts here, because the columns a parser keys on are
 * those positions.
 *
 * EVERY DIGIT IS PRINTED AS # by default, so dates, amounts, balances and
 * account numbers do not survive and the output can be shared to describe a
 * layout. Words are kept, merchant names included: read it before you paste
 * it anywhere. --unmasked prints the real text, for your own eyes only.
 */

function pageRange(spec: string | undefined, total: number): Set<number> {
  if (spec === undefined) return new Set(Array.from({ length: total }, (_, i) => i + 1));
  const [from, to] = spec.split('-').map(Number);
  const last = Number.isFinite(to) ? to : from;
  return new Set(Array.from({ length: Math.max(0, last - from + 1) }, (_, i) => from + i));
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (file === undefined || file.startsWith('--')) {
    console.error('Usage: npm run pdf:layout -- <statement.pdf> [--pages=1-3] [--unmasked]');
    process.exit(1);
  }
  const mask = hasFlag('unmasked') ? (s: string) => s : (s: string) => s.replace(/\d/g, '#');

  const lines = await extractLines(readFileSync(file));
  if (lines.length === 0) {
    console.log('No text layer: this PDF is a scan, and the import cannot read it.');
    return;
  }
  const pages = pageRange(arg('pages'), Math.max(...lines.map((l) => l.page)));

  let page = 0;
  for (const line of lines) {
    if (!pages.has(line.page)) continue;
    if (line.page !== page) {
      page = line.page;
      console.log(`\n=== page ${page} ===`);
    }
    // Both edges: a right-aligned amount column is steady at its END, not its start.
    const cells = line.cells
      .map((c) => `${Math.round(c.x)}-${Math.round(c.xEnd)}: ${mask(c.text)}`)
      .join('  |  ');
    console.log(`y${String(Math.round(line.y)).padStart(4)}  ${cells}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
