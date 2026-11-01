import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import { extractLines } from '../src/lib/connectors/pdf/extract';
import { wellsFargoCardPageHeader } from '../src/lib/connectors/pdf/layouts/wellsFargoCard';
import { groupStatementPages, type PageHeader } from '../src/lib/connectors/pdf/scanBundle';
import { arg, hasFlag } from './args';

/**
 * Usage:
 *   npm run pdf:ocr -- <scan.pdf> [more...] --out=<folder> [--dpi=300]
 *     [--tesseract=<tesseract.exe>] [--poppler=<poppler bin folder>] [--keep]
 *
 * Turns scans of paper statements (image-only PDFs, which the import refuses
 * as having no text layer) into PDFs it reads: one file per statement, with
 * the text OCR put on each page. The import's checks are unchanged: a
 * statement is still refused whole unless its rows add up to its balances.
 *
 * Needs two programs on this machine, found on PATH, in their usual Windows
 * install folders, or where --tesseract and --poppler point (also the
 * TESSERACT_EXE and POPPLER_BIN environment variables):
 *   Tesseract OCR   winget install --id UB-Mannheim.TesseractOCR -e
 *   Poppler         winget install --id oschwartz10612.Poppler -e
 *
 * For each scan: pdftoppm rasterises every page (grey, --dpi); each page is
 * deskewed, since a fed sheet sits a few degrees off and OCR then puts the
 * words of one row on different baselines; Tesseract writes a searchable PDF;
 * pdfseparate splits it into pages. Then, across every scan given, each page
 * is placed by the header its own text carries (the statement period and
 * "Page N of M", read by the layout that will import it) and pdfunite joins
 * each statement's pages, in printed order, into <out>/statement-<closing
 * date>.pdf. Sheets can be fed in any order and split across scans.
 *
 * Prints counts, page positions and statement dates only: never a line of a
 * statement's text. The working files (page images, the OCR'd bundle) are
 * removed afterwards unless --keep.
 */

const DEFAULT_DPI = 300;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function onPath(name: string): string | null {
  try {
    const where = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(where, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).find((l) => l.trim() !== '');
    return first === undefined ? null : first.trim();
  } catch {
    return null;
  }
}

/** Tesseract's executable: the flag, the environment, PATH, or its installer's folder. */
function findTesseract(): string {
  const given = arg('tesseract') ?? process.env.TESSERACT_EXE;
  if (given !== undefined) return given;
  const path = onPath('tesseract');
  if (path !== null) return path;
  const usual = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tesseract-OCR', 'tesseract.exe');
  if (existsSync(usual)) return usual;
  return fail('Tesseract not found: install it (winget install --id UB-Mannheim.TesseractOCR -e) or pass --tesseract=<tesseract.exe>');
}

/** Poppler's bin folder (pdftoppm, pdfseparate, pdfunite): the flag, the environment, PATH, or winget's package folder. */
function findPoppler(): string {
  const given = arg('poppler') ?? process.env.POPPLER_BIN;
  if (given !== undefined) return given;
  const path = onPath('pdftoppm');
  if (path !== null) return resolve(path, '..');
  const packages = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(packages)) {
    for (const pkg of readdirSync(packages).filter((d) => /poppler/i.test(d))) {
      for (const version of readdirSync(join(packages, pkg))) {
        const bin = join(packages, pkg, version, 'Library', 'bin');
        if (existsSync(join(bin, 'pdftoppm.exe'))) return bin;
      }
    }
  }
  return fail('Poppler not found: install it (winget install --id oschwartz10612.Poppler -e) or pass --poppler=<its bin folder>');
}

/**
 * The angle a page's text lines sit at, by the shear that makes the ink's
 * row profile peakiest, to a fiftieth of a degree. Reads pixels only.
 */
async function skewDegrees(file: string): Promise<number> {
  const { data, info } = await sharp(file).greyscale().resize({ width: 640 }).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const ink: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (data[y * width + x] < 140) ink.push(x, y);
  }
  const score = (deg: number): number => {
    const t = Math.tan((deg * Math.PI) / 180);
    const rows = new Float64Array(height + width + 2);
    const lift = Math.ceil(Math.abs(t) * width);
    for (let i = 0; i < ink.length; i += 2) rows[Math.round(ink[i + 1] + ink[i] * t) + lift] += 1;
    let s = 0;
    for (const v of rows) s += v * v;
    return s;
  };
  let best = 0;
  let bestScore = -1;
  for (let a = -5; a <= 5.0001; a += 0.1) {
    const s = score(a);
    if (s > bestScore) [bestScore, best] = [s, a];
  }
  const coarse = best;
  for (let a = coarse - 0.1; a <= coarse + 0.1001; a += 0.02) {
    const s = score(a);
    if (s > bestScore) [bestScore, best] = [s, a];
  }
  return best;
}

/** The page rotated level, cut back to its own size on a white ground. */
async function deskew(src: string, dest: string): Promise<number> {
  const deg = await skewDegrees(src);
  const meta = await sharp(src).metadata();
  const rotated = await sharp(src).rotate(deg, { background: '#ffffff' }).toBuffer({ resolveWithObject: true });
  const width = Math.min(meta.width, rotated.info.width);
  const height = Math.min(meta.height, rotated.info.height);
  await sharp(rotated.data)
    .extract({
      left: Math.max(0, Math.round((rotated.info.width - width) / 2)),
      top: Math.max(0, Math.round((rotated.info.height - height) / 2)),
      width,
      height,
    })
    .png({ compressionLevel: 6 })
    .withMetadata({ density: meta.density ?? DEFAULT_DPI })
    .toFile(dest);
  return deg;
}

interface ScanPages {
  /** One single-page PDF per page, in the scan's order. */
  files: string[];
  bundle: string;
}

async function ocrScan(scan: string, work: string, dpi: number, tesseract: string, poppler: string): Promise<ScanPages> {
  const name = basename(scan, '.pdf');
  const raw = join(work, name, 'raw');
  const level = join(work, name, 'level');
  const pages = join(work, name, 'pages');
  for (const dir of [raw, level, pages]) mkdirSync(dir, { recursive: true });

  execFileSync(join(poppler, 'pdftoppm'), ['-r', String(dpi), '-gray', '-png', scan, join(raw, 'p')], { stdio: 'inherit' });
  const images = readdirSync(raw).filter((f) => f.endsWith('.png')).sort();
  let tilted = 0;
  for (const image of images) {
    const deg = await deskew(join(raw, image), join(level, image));
    if (Math.abs(deg) >= 0.5) tilted++;
  }
  console.log(`  ${name}: ${images.length} pages rasterised at ${dpi} dpi, ${tilted} levelled by half a degree or more`);

  const list = join(work, name, 'pages.txt');
  writeFileSync(list, images.map((f) => join(level, f)).join('\n') + '\n');
  const bundle = join(work, name, 'ocr');
  execFileSync(tesseract, [list, bundle, '-l', 'eng', 'pdf'], { stdio: ['ignore', 'ignore', 'ignore'] });
  execFileSync(join(poppler, 'pdfseparate'), [`${bundle}.pdf`, join(pages, 'p-%03d.pdf')], { stdio: 'inherit' });
  const files = readdirSync(pages).filter((f) => f.endsWith('.pdf')).sort().map((f) => join(pages, f));
  console.log(`  ${name}: OCR done, ${files.length} pages`);
  return { files, bundle: `${bundle}.pdf` };
}

async function main(): Promise<void> {
  const scans = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const out = arg('out');
  if (scans.length === 0 || out === undefined) {
    fail('Usage: npm run pdf:ocr -- <scan.pdf> [more...] --out=<folder> [--dpi=300] [--tesseract=<exe>] [--poppler=<bin folder>] [--keep]');
  }
  const dpi = Number(arg('dpi') ?? DEFAULT_DPI);
  if (!Number.isInteger(dpi) || dpi < 150 || dpi > 600) fail('--dpi takes a whole number from 150 to 600');
  const tesseract = findTesseract();
  const poppler = findPoppler();
  mkdirSync(out, { recursive: true });
  const work = join(out, 'work');

  const pages: { id: string; file: string; header: PageHeader }[] = [];
  for (const scan of scans) {
    if (!existsSync(scan)) fail(`${scan}: no such file`);
    console.log(basename(scan));
    const { files, bundle } = await ocrScan(scan, work, dpi, tesseract, poppler);
    const lines = await extractLines(readFileSync(bundle));
    const byPage = new Map<number, typeof lines>();
    for (const line of lines) byPage.set(line.page, [...(byPage.get(line.page) ?? []), line]);
    files.forEach((file, index) => {
      const page = index + 1;
      pages.push({ id: `${basename(scan, '.pdf')}:${page}`, file, header: wellsFargoCardPageHeader(byPage.get(page) ?? []) });
    });
  }

  const { groups, orphans } = groupStatementPages(pages.map((p) => ({ id: p.id, header: p.header })));
  const fileOf = new Map(pages.map((p) => [p.id, p.file]));
  console.log(
    `\n${pages.length} pages, ${groups.length} statements, ${orphans.length} pages with no readable statement header (terms, inserts, blanks, or a header OCR could not read): ${orphans.join(' ') || 'none'}`,
  );
  let incomplete = 0;
  for (const group of groups) {
    const end = group.period.split('_')[1];
    let name = `statement-${end}.pdf`;
    if (existsSync(join(out, name))) name = `statement-${end}-b.pdf`;
    execFileSync(join(poppler, 'pdfunite'), [...group.pages.map((p) => fileOf.get(p) as string), join(out, name)], { stdio: 'inherit' });
    if (!group.complete) incomplete++;
    console.log(
      `  ${group.period.replace('_', ' to ')}  pages ${group.pages.join(', ')}  printed ${group.printed.map((n) => n ?? '?').join(',')} of ${group.expected ?? '?'}  ${group.complete ? 'complete' : 'CHECK: pages missing or unnumbered'}  -> ${name}`,
    );
  }
  console.log(`\n${groups.length} files written to ${out}${incomplete > 0 ? `; ${incomplete} may be missing a page, which the import's balance check will refuse` : ''}`);
  if (!hasFlag('keep')) rmSync(work, { recursive: true, force: true });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
