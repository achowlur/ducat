import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { PrismaClient } from '../src/generated/prisma/client';
import { generateInsights } from '../src/lib/insights/engine';
import { installRulePack } from '../src/lib/sync/rulePack';
import { assembleApng, type Frame } from './apng';
import { frame, hero } from './readmeArt';
import { buildDemoData, writeDemoData } from '../src/lib/demo/data';

/**
 * `npm run screenshots` — retake the README's screenshots and walkthrough.
 *
 * Everything it shows is the INVENTED demo data (src/lib/demo/data.ts), seeded
 * into a throwaway database in the temp folder: this command never opens
 * data/ducat.db and never reads .env's DATABASE_URL, so no real figure can
 * reach an image. The app is a PRODUCTION build — no dev indicator in the
 * corner, production headers — built into `.next-capture/`, never `.next/`,
 * so it is safe beside a running dev server. Playwright drives its own
 * Chromium with a fresh profile.
 *
 * Output: docs/assets/screenshots/{overview,trends,insights,transactions}.png,
 * each the same size in the same browser frame, the banner
 * docs/assets/screenshots/hero.png (scripts/readmeArt.ts), and
 * docs/assets/walkthrough.png (an animated PNG, see scripts/apng.ts).
 * Sepia is the app's default theme, so no theme is set.
 */

const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = '.next-capture';
const SHOTS = join('docs', 'assets', 'screenshots');
const WALKTHROUGH = join('docs', 'assets', 'walkthrough.png');

// One size for every screen: four different heights made the README's grid
// ragged. What sits below the fold is the live demo's to show.
const PAGES: { name: string; path: string }[] = [
  { name: 'overview', path: '/' },
  { name: 'trends', path: '/trends' },
  { name: 'insights', path: '/insights' },
  { name: 'transactions', path: '/transactions' },
];
const SHOT = { width: 1280, height: 1000 };

const log = (line: string) => console.log(line);

async function seedThrowawayDatabase(dir: string): Promise<string> {
  const path = join(dir, 'demo.db').replace(/\\/g, '/');
  const url = `file:${path}`;
  const conn = await new PrismaBetterSqlite3({ url }).connect();
  const migrations = join(process.cwd(), 'prisma', 'migrations');
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    await conn.executeScript(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'));
  }
  await conn.dispose();
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  try {
    await writeDemoData(prisma, buildDemoData(new Date()));
    await installRulePack(prisma);
    await generateInsights(prisma);
  } finally {
    await prisma.$disconnect();
  }
  return url;
}

function run(args: string[], env: NodeJS.ProcessEnv, wait: boolean): Promise<void> | ChildProcess {
  const child = spawn(process.execPath, [join('node_modules', 'next', 'dist', 'bin', 'next'), ...args], {
    env,
    stdio: wait ? 'inherit' : 'ignore',
  });
  if (!wait) return child;
  return new Promise((resolve, reject) =>
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`next ${args[0]} exited ${code}`)))),
  );
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the capture server did not answer on ${BASE}`);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
}

async function main(): Promise<void> {
  try {
    await fetch(`${BASE}/`);
    throw new Error(`port ${PORT} is already in use — stop whatever is listening there first`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('port ')) throw e;
  }

  const dir = mkdtempSync(join(tmpdir(), 'ducat-capture-'));
  let server: ChildProcess | null = null;
  try {
    log('Seeding invented demo data into a throwaway database…');
    const url = await seedThrowawayDatabase(dir);
    // Next fills any variable the environment does NOT set from .env, so every
    // one that could reach real data or a real service is set here, empty
    // where it must be off — the app reads an empty value as unset. The
    // database is the throwaway one; no feed, no rate key, no Turso token, no
    // login gate.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: url,
      NEXT_DIST_DIR: DIST,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      SIMPLEFIN_ACCESS_URL: '',
      FRED_API_KEY: '',
      TURSO_AUTH_TOKEN: '',
      AUTH_PASSWORD_HASH: '',
      SESSION_SECRET: '',
      AUTH_TOTP_SECRET: '',
    };

    log(`Building a production app into ${DIST}/ …`);
    await run(['build'], env, true);
    server = run(['start', '-H', '127.0.0.1', '-p', String(PORT)], env, false) as ChildProcess;
    await waitForServer();

    const browser = await chromium.launch();
    try {
      mkdirSync(SHOTS, { recursive: true });
      const shots = await browser.newContext({ viewport: SHOT, deviceScaleFactor: 1.5, colorScheme: 'light' });
      const page = await shots.newPage();
      const raw = new Map<string, string>();
      for (const p of PAGES) {
        await page.goto(`${BASE}${p.path}`);
        await settle(page);
        raw.set(p.name, (await page.screenshot({ type: 'png' })).toString('base64'));
      }
      // Framed, and the banner, rendered from those same captures.
      const art = await shots.newPage();
      const render = async (html: string, file: string) => {
        await art.setContent(html, { waitUntil: 'load' });
        writeFileSync(file, await art.locator('#art').screenshot({ type: 'png', omitBackground: true }));
        log(`  ${file}`);
      };
      await art.setViewportSize({ width: 1600, height: 900 });
      for (const p of PAGES) await render(frame(raw.get(p.name)!, p.path), join(SHOTS, `${p.name}.png`));
      await render(hero(raw.get('overview')!, raw.get('insights')!), join(SHOTS, 'hero.png'));
      await shots.close();

      // The walkthrough: each screen held long enough to read, a few scroll
      // steps between, and one P2P suggestion confirmed — the throwaway
      // database takes the write.
      const film = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 1, colorScheme: 'light' });
      const tab = await film.newPage();
      const frames: Frame[] = [];
      const grab = async (delayMs: number) => frames.push({ png: await tab.screenshot({ type: 'png' }), delayMs });
      const scrollSteps = async (steps: number, by: number) => {
        for (let i = 0; i < steps; i++) {
          await tab.mouse.wheel(0, by);
          await tab.waitForTimeout(250);
          await grab(i === steps - 1 ? 2200 : 280);
        }
      };
      for (const [path, hold, scroll] of [
        ['/', 2600, 0],
        ['/trends', 1600, 3],
        ['/insights', 2000, 4],
      ] as const) {
        await tab.goto(`${BASE}${path}`);
        await settle(tab);
        await grab(hold);
        if (scroll > 0) await scrollSteps(scroll, 320);
      }
      await tab.goto(`${BASE}/transactions?review=1`);
      await settle(tab);
      await grab(2400);
      const confirm = tab.locator('button[aria-label^="Confirm"]').first();
      if ((await confirm.count()) > 0) {
        await confirm.hover();
        await grab(900);
        await confirm.click();
        await tab.waitForTimeout(1500);
        await settle(tab);
        await grab(2600);
      }
      writeFileSync(WALKTHROUGH, assembleApng(frames));
      log(`  ${WALKTHROUGH} (${frames.length} frames)`);
      await film.close();
    } finally {
      await browser.close();
    }
  } finally {
    // The server holds the throwaway database open, and Windows refuses to
    // delete an open file, so it must be gone before the cleanup runs.
    if (server !== null && server.exitCode === null) {
      const exited = new Promise((resolve) => server!.once('exit', resolve));
      server.kill();
      await exited;
    }
    for (const path of [dir, DIST]) {
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch {
        console.warn(`Could not remove ${path}; it is safe to delete by hand.`);
      }
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
