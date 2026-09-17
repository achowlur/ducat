/**
 * CI: a pull request that changes a pictured screen retakes the README
 * screenshots or says why not (scripts/screenshotSync.ts).
 *
 * Inputs come from the environment, like check-public-text.ts:
 *   EVENT_NAME           the GitHub event; anything but pull_request is skipped
 *   BASE_SHA, HEAD_SHA   the pull request's range
 *   PR_BODY              its description (where a waiver line lives)
 * Runs on pull requests only: a push to main has already been through one.
 *
 *   npx tsx scripts/check-screenshots.ts
 */
import { execFileSync } from 'node:child_process';
import { screenshotVerdict } from './screenshotSync';

const base = (process.env.BASE_SHA ?? '').trim();
const head = (process.env.HEAD_SHA ?? '').trim() || 'HEAD';

if (process.env.EVENT_NAME !== 'pull_request' || !base || /^0+$/.test(base)) {
  console.log('Screenshot sync: not a pull request — nothing to check.');
} else {
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const verdict = screenshotVerdict(changed, process.env.PR_BODY ?? '');
  if (verdict.ok) {
    console.log(`Screenshot sync: ok — ${verdict.reason}.`);
  } else {
    console.error(`Screenshot sync failed: ${verdict.reason}`);
    process.exitCode = 1;
  }
}
