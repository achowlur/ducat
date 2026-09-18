/**
 * HTML for the README's images, rendered to PNG by `npm run screenshots` in the
 * same Playwright Chromium that takes the screenshots — so the hero and the
 * framed screenshots are rebuilt from the app as it is, every time, and can
 * never show a screen the app no longer has.
 *
 * Two images:
 *  - frame(): one screenshot in a plain browser window, every one the SAME
 *    size, so the README's gallery lines up (the unframed captures were cut
 *    to four different heights, and the grid looked ragged);
 *  - hero(): the banner — coin, wordmark, one-line pitch and three points on
 *    the left, Overview in front of Insights on the right. Popular
 *    self-hosted projects lead with ONE product image under the logo; this is
 *    that image.
 *
 * Colours are the app's sepia tokens. Type is the app's own stack (Bahnschrift
 * and Cascadia Mono on the Windows machine that runs the capture), and the
 * wordmark is drawn as strokes, the same paths as the logo.
 */

const PAPER = '#f2e9d8';
const INK = '#3b3227';
const FAINT = '#6f6153';
const RULE = '#d9cbb0';
const CHIP = '#eae0c8';
const GOLD = '#9c5a12';

const SANS = "Bahnschrift, 'Segoe UI', system-ui, sans-serif";
const MONO = "'Cascadia Mono', Consolas, ui-monospace, monospace";

const COIN = `<svg viewBox="0 0 84 84" width="64" height="64" aria-hidden="true">
  <circle cx="42" cy="42" r="39" fill="${GOLD}"/>
  <circle cx="42" cy="42" r="32" fill="none" stroke="${PAPER}" stroke-width="1.5" stroke-dasharray="2 3"/>
  <path d="M32 26 H44 C54 26 58 33 58 42 C58 51 54 58 44 58 H32 Z" fill="none" stroke="${PAPER}" stroke-width="5" stroke-linejoin="round"/>
  <line x1="27" y1="42" x2="38" y2="42" stroke="${PAPER}" stroke-width="4"/>
</svg>`;

const WORDMARK = `<svg viewBox="0 0 260 52" width="200" height="40" aria-hidden="true">
  <g fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="square" stroke-linejoin="miter">
    <path d="M3.5 3.5 H16 C28 3.5 31.5 12 31.5 24 C31.5 36 28 44.5 16 44.5 H3.5 Z"/>
    <path transform="translate(56 0)" d="M3.5 3.5 V30 C3.5 40 9 44.5 17 44.5 C25 44.5 30.5 40 30.5 30 V3.5"/>
    <path transform="translate(112 0)" d="M31 9 C28 5 23 3.5 18 3.5 C9 3.5 3.5 11 3.5 24 C3.5 37 9 44.5 18 44.5 C23 44.5 28 43 31 39" stroke-linecap="butt"/>
    <path transform="translate(166 0)" d="M2 46 L17 3.5 L32 46 M8.5 32 H25.5" stroke-linecap="butt"/>
    <path transform="translate(222 0)" d="M0 3.5 H34 M17 3.5 V48" stroke-linecap="butt"/>
  </g>
</svg>`;

const page = (body: string, width: number) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; }
  body { width: ${width}px; font-family: ${SANS}; color: ${INK}; }
  .window { background: ${PAPER}; border: 1px solid ${RULE}; border-radius: 12px; overflow: hidden;
            box-shadow: 0 18px 40px -18px rgba(59, 50, 39, 0.45), 0 2px 6px rgba(59, 50, 39, 0.12); }
  .bar { height: 34px; display: flex; align-items: center; gap: 7px; padding: 0 14px; background: ${CHIP};
         border-bottom: 1px solid ${RULE}; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: ${RULE}; display: block; }
  .url { margin-left: 14px; flex: 1; max-width: 420px; height: 20px; border-radius: 10px; background: ${PAPER};
         font: 12px ${MONO}; color: ${FAINT}; display: flex; align-items: center; padding: 0 12px; }
  .window img { display: block; width: 100%; }
</style></head><body>${body}</body></html>`;

const windowHtml = (png: string, path: string) =>
  `<div class="window"><div class="bar"><i></i><i></i><i></i><span class="url">localhost:3000${path}</span></div>` +
  `<img src="data:image/png;base64,${png}"></div>`;

/** One screenshot in a browser window, on a transparent margin. */
export function frame(pngBase64: string, path: string): string {
  return page(`<div id="art" style="padding: 18px 22px 30px">${windowHtml(pngBase64, path)}</div>`, 1320);
}

/** The README banner. `front` is Overview, `back` is Insights. */
export function hero(front: string, back: string): string {
  const point = (text: string) =>
    `<li style="display:flex;gap:10px;align-items:baseline;margin:0 0 10px"><span style="color:${GOLD};font-weight:700">●</span><span>${text}</span></li>`;
  return page(
    `<div id="art" style="padding: 10px 14px 34px">
      <div style="position:relative;height:760px;border-radius:22px;overflow:hidden;background:${PAPER};border:1px solid ${RULE};
                  box-shadow: 0 24px 50px -28px rgba(59,50,39,0.5)">
        <div style="position:absolute;left:64px;top:92px;width:470px">
          <div style="display:flex;align-items:center;gap:18px">${COIN}${WORDMARK}</div>
          <h1 style="margin:44px 0 0;font-size:46px;line-height:1.08;font-weight:600;letter-spacing:-0.01em">
            Your money,<br>on your machine.</h1>
          <p style="margin:20px 0 34px;font-size:19px;line-height:1.5;color:${FAINT}">
            A local-first personal finance tracker with an insights engine that refuses to guess.</p>
          <ul style="list-style:none;padding:0;margin:0;font-size:17px;line-height:1.4">
            ${point('Every account, every category, one SQLite file of your own')}
            ${point('Insights that name what they cannot know')}
            ${point('Runs on localhost, or on your own Vercel and Turso')}
          </ul>
        </div>
        <div style="position:absolute;left:640px;top:58px;width:900px;opacity:0.97">${windowHtml(back, '/insights')}</div>
        <div style="position:absolute;left:560px;top:196px;width:960px">${windowHtml(front, '/')}</div>
      </div>
    </div>`,
    1600,
  );
}
