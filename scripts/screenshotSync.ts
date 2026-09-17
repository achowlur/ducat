/**
 * The README pictures four screens, so a change to what those screens render
 * owes the pictures a retake — or a stated reason it does not.
 *
 * A rule people have to remember is what let README's command table drift
 * twice; this makes skipping a retake a WRITTEN decision instead of a
 * forgotten one. It cannot tell whether a new screenshot actually shows the
 * change — only that nobody skipped the question silently.
 */

/** Paths whose changes can alter what a pictured screen shows. */
export const PICTURED: RegExp[] = [
  /^src\/app\/(page\.tsx|layout\.tsx|globals\.css)$/,
  /^src\/app\/(trends|insights|transactions)\//,
  /^src\/components\//,
  /^src\/lib\/ui\//,
  /^src\/lib\/insights\//,
  /^scripts\/demoData\.ts$/,
];

export const SCREENSHOTS = /^docs\/assets\/screenshots\/[^/]+\.png$/;

/** `screenshots: unchanged — <reason>` on a line of its own, with a real reason. */
export const WAIVER = /^\s*screenshots:\s*unchanged\s*[—–-]+\s*(\S.{3,})$/im;

export type Verdict =
  | { ok: true; reason: string }
  | { ok: false; reason: string };

export function screenshotVerdict(changedFiles: string[], prBody: string): Verdict {
  const files = changedFiles.map((f) => f.replace(/\\/g, '/'));
  const pictured = files.filter((f) => PICTURED.some((re) => re.test(f)));
  if (pictured.length === 0) return { ok: true, reason: 'no pictured screen changed' };
  if (files.some((f) => SCREENSHOTS.test(f))) return { ok: true, reason: 'screenshots retaken in this change' };
  const waiver = WAIVER.exec(prBody);
  if (waiver !== null) return { ok: true, reason: `waived: ${waiver[1].trim()}` };
  return {
    ok: false,
    reason:
      `this change touches what the README pictures (${pictured.slice(0, 5).join(', ')}${pictured.length > 5 ? ', …' : ''}) ` +
      'but not docs/assets/screenshots/. Run `npm run screenshots` and commit the result, or add a line ' +
      '`screenshots: unchanged — <why>` to the pull request description.',
  };
}
