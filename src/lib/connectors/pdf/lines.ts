/**
 * A statement page as LINES of positioned cells, built from the text items a
 * PDF yields.
 *
 * Position is the point. A deposit statement prints deposits and withdrawals
 * in separate columns with no sign, so a number's meaning is the column it
 * sits in; flattening a page to plain text keeps the number and loses that.
 * Every layout parser reads these lines, never raw items.
 */

/** One text item as the extractor reports it (PDF space: origin bottom-left). */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

/** A run of items close enough together to read as one piece of text. */
export interface TextCell {
  x: number;
  xEnd: number;
  text: string;
}

export interface TextLine {
  /** 1-based page number. */
  page: number;
  /** Baseline, PDF space: larger is HIGHER on the page. */
  y: number;
  cells: TextCell[];
  /** The cells joined by single spaces, for matching headings and labels. */
  text: string;
}

/** Items whose baselines differ by less than this sit on one line. */
const SAME_LINE = 2;
/** A gap under this fraction of the font size joins items with no space (a word split mid-way). */
const JOIN_TIGHT = 0.12;
/** A gap under this fraction of the font size is a word space; anything wider starts a new cell. */
const JOIN_SPACED = 1.2;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function linesOfPage(page: number, items: PdfTextItem[]): TextLine[] {
  const visible = items.filter((i) => collapse(i.str) !== '');
  // Top of the page first: PDF y grows upward.
  const sorted = [...visible].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PdfTextItem[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    if (row !== undefined && Math.abs(row[0].y - item.y) < SAME_LINE) row.push(item);
    else rows.push([item]);
  }

  return rows.map((row) => {
    const ordered = [...row].sort((a, b) => a.x - b.x);
    const cells: TextCell[] = [];
    for (const item of ordered) {
      const text = item.str.replace(/\s+/g, ' ');
      const last = cells[cells.length - 1];
      const gap = last === undefined ? Infinity : item.x - last.xEnd;
      const size = item.fontSize > 0 ? item.fontSize : 10;
      if (last !== undefined && gap < JOIN_SPACED * size) {
        last.text = gap < JOIN_TIGHT * size ? last.text + text : `${last.text} ${text}`;
        last.xEnd = Math.max(last.xEnd, item.x + item.width);
      } else {
        cells.push({ x: item.x, xEnd: item.x + item.width, text });
      }
    }
    const tidy = cells.map((c) => ({ ...c, text: collapse(c.text) }));
    return {
      page,
      y: row[0].y,
      cells: tidy,
      text: tidy.map((c) => c.text).join(' '),
    };
  });
}

/** Every page's lines, top to bottom, pages in order. */
export function toLines(pages: PdfTextItem[][]): TextLine[] {
  return pages.flatMap((items, index) => linesOfPage(index + 1, items));
}
