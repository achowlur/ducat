import { describe, expect, it } from 'vitest';
import { extractLines } from './extract';
import { toLines, type PdfTextItem } from './lines';

const item = (str: string, x: number, y: number, width = str.length * 5, fontSize = 10): PdfTextItem => ({
  str,
  x,
  y,
  width,
  fontSize,
});

describe('toLines', () => {
  it('puts items sharing a baseline on one line, top of the page first', () => {
    const lines = toLines([
      [item('second', 40, 600), item('first', 40, 700), item('right', 400, 700.8)],
    ]);
    expect(lines.map((l) => l.text)).toEqual(['first right', 'second']);
    expect(lines[0].cells.map((c) => c.x)).toEqual([40, 400]);
  });

  it('rejoins a word the PDF split, and keeps word spaces inside a cell', () => {
    const [line] = toLines([
      [item('PAY', 40, 700, 15), item('MENT', 55, 700, 20), item('THANK', 78, 700, 25), item('YOU', 106, 700, 15)],
    ]);
    expect(line.cells).toHaveLength(1);
    expect(line.cells[0].text).toBe('PAYMENT THANK YOU');
    expect(line.cells[0].xEnd).toBe(121);
  });

  // The reason this module exists: a deposit and a withdrawal differ only in
  // the column their number sits in.
  it('starts a new cell at a column gap', () => {
    const [line] = toLines([
      [item('10/01', 30, 650), item('DEPOSIT', 80, 650), item('125.00', 400, 650), item('900.00', 520, 650)],
    ]);
    expect(line.cells.map((c) => [c.x, c.text])).toEqual([
      [30, '10/01'],
      [80, 'DEPOSIT'],
      [400, '125.00'],
      [520, '900.00'],
    ]);
  });

  it('numbers pages from 1 and keeps them in order', () => {
    const lines = toLines([[item('one', 40, 700)], [item('two', 40, 700)]]);
    expect(lines.map((l) => [l.page, l.text])).toEqual([
      [1, 'one'],
      [2, 'two'],
    ]);
  });

  it('drops whitespace-only items and collapses runs of spaces', () => {
    const [line] = toLines([[item('  ', 10, 700), item('EXAMPLE   GROCER', 40, 700)]]);
    expect(line.cells).toEqual([{ x: 40, xEnd: 120, text: 'EXAMPLE GROCER' }]);
  });
});

/**
 * A one-page PDF written by hand, so the end-to-end test needs no binary
 * fixture: each entry is drawn in Helvetica at its own position.
 */
function minimalPdf(texts: { x: number; y: number; text: string }[]): Uint8Array {
  const stream = texts.map((t) => `BT /F1 10 Tf 1 0 0 1 ${t.x} ${t.y} Tm (${t.text}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

describe('extractLines', () => {
  it('reads a real PDF into positioned lines', async () => {
    const lines = await extractLines(
      minimalPdf([
        { x: 36, y: 720, text: 'ACCOUNT ACTIVITY' },
        { x: 36, y: 700, text: '01/03' },
        { x: 120, y: 700, text: 'EXAMPLE GROCER SPRINGFIELD' },
        { x: 520, y: 700, text: '40.00' },
      ]),
    );
    expect(lines.map((l) => l.text)).toEqual(['ACCOUNT ACTIVITY', '01/03 EXAMPLE GROCER SPRINGFIELD 40.00']);
    expect(lines[1].cells.map((c) => Math.round(c.x))).toEqual([36, 120, 520]);
  });

  it('returns no lines for a page with no text layer', async () => {
    expect(await extractLines(minimalPdf([]))).toEqual([]);
  });
});
