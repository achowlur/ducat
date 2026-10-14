import { extractTextItems } from 'unpdf';
import { toLines, type TextLine } from './lines';

/**
 * A PDF file's text as positioned lines. Runs locally on the bytes it is
 * given: handed bytes rather than a URL, pdf.js fetches nothing.
 *
 * A scanned statement has no text layer and comes back with no lines; the
 * caller refuses it rather than guessing, since there is no OCR here.
 */
export async function extractLines(data: Uint8Array): Promise<TextLine[]> {
  // pdf.js takes ownership of the buffer it is given; hand it a copy.
  const { items } = await extractTextItems(new Uint8Array(data));
  return toLines(items);
}
