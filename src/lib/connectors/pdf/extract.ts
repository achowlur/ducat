import { extractTextItems, getDocumentProxy } from 'unpdf';
import { toLines, type TextLine } from './lines';

/**
 * A PDF file's text as positioned lines. Runs locally on the bytes it is
 * given: handed bytes rather than a URL, pdf.js fetches nothing.
 *
 * A scanned statement has no text layer and comes back with no lines; the
 * caller refuses it rather than guessing, since there is no OCR here.
 */
export async function extractLines(data: Uint8Array): Promise<TextLine[]> {
  // pdf.js takes ownership of the buffer it is given; hand it a copy. Errors
  // only: an older statement set in a standard font it does not embed (Arial,
  // say) makes pdf.js warn that it has no file to DRAW that font with. Nothing
  // here draws. The text and its positions come from the PDF itself, and a
  // misread still fails the statement's own balance check.
  const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  const { items } = await extractTextItems(pdf);
  return toLines(items);
}
