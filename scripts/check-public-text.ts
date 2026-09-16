/**
 * The half of the public boundary that never lands in a tracked file.
 *
 * privacy.test.ts reads every file in the tree, but a commit message, a
 * commit's author and committer emails, a branch name, and a pull request's
 * title and description are published just as surely and are invisible to
 * it. CI runs this on every pull request (including edits to its title or
 * description) and on every push to main, over the commits that change
 * brings in.
 *
 * Inputs come from the environment, never interpolated into a shell line,
 * so a pull request's own text cannot become a command:
 *   BASE_SHA   start of the range (exclusive); empty or all zeros = HEAD_SHA only
 *   HEAD_SHA   end of the range (inclusive); defaults to HEAD
 *   PR_TITLE, PR_BODY, PR_BRANCH   present on pull request runs only
 *
 * A push to main is checked AFTER it lands: a web merge's commit does not
 * exist until the merge happens, so this reports that case rather than
 * preventing it. The account's email-privacy setting is the prevention.
 *
 *   npx tsx scripts/check-public-text.ts
 */
import { execFileSync } from "node:child_process";
import { isNoReplyIdentity, scanText } from "./privacyScan";

const RECORD = "\x1e";
const FIELD = "\x1f";

const base = (process.env.BASE_SHA ?? "").trim();
const head = (process.env.HEAD_SHA ?? "").trim() || "HEAD";
const range = !base || /^0+$/.test(base) ? ["-1", head] : [`${base}..${head}`];

const log = execFileSync(
  "git",
  ["log", `--format=%h${FIELD}%ae${FIELD}%ce${FIELD}%B${RECORD}`, ...range],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);

const violations: string[] = [];
let commits = 0;

for (const record of log.split(RECORD)) {
  const entry = record.replace(/^\s+/, "");
  if (!entry) continue;
  const [hash, authorEmail, committerEmail, message = ""] = entry.split(FIELD);
  commits += 1;
  if (!isNoReplyIdentity(authorEmail)) {
    violations.push(`commit ${hash} — author email is not a GitHub no-reply address`);
  }
  if (!isNoReplyIdentity(committerEmail)) {
    violations.push(`commit ${hash} — committer email is not a GitHub no-reply address`);
  }
  violations.push(...scanText(`commit ${hash} message`, message));
}

const scanned = [`${commits} commit(s)`];
for (const [label, value] of [
  ["branch name", process.env.PR_BRANCH],
  ["pull request title", process.env.PR_TITLE],
  ["pull request description", process.env.PR_BODY],
] as const) {
  if (value) {
    scanned.push(label);
    violations.push(...scanText(label, value));
  }
}

if (violations.length > 0) {
  console.error(`Public text check failed (${scanned.join(", ")}):`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`Public text is clean: ${scanned.join(", ")}.`);
