import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The instructions an agent reads have to stay small, routed and alive.
 *
 * CLAUDE.md loads into every session. It was split from 1,308 lines to 304 on
 * 2026-08-01 and had grown back to 585 by 2026-10-04, and the mechanism was
 * the command table's: not neglect but SHIPPING. Each feature added a rule
 * line, and each rule line collected its story. So the second split moved
 * area rules into `.claude/rules/` (loaded only when a matching file is read
 * or edited) and procedures into `.claude/skills/`, and this file holds the
 * shape in place instead of a convention asking people to remember it.
 *
 * What it fails on: CLAUDE.md over its budget; a rules file whose `paths:`
 * glob matches no tracked file (a rename would silently stop the rule from
 * ever loading); a rules file without an evidence file, or an evidence file
 * no rules file names; a skill without a description (the description is all
 * that is in context until the skill runs); and any rules file or skill that
 * CLAUDE.md does not route to.
 */
const CLAUDE_MD_MAX_LINES = 200;

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const tracked = execSync("git ls-files", { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const claudeMd = read("CLAUDE.md");

const rulesDir = ".claude/rules";
const skillsDir = ".claude/skills";
const ruleFiles = readdirSync(join(root, rulesDir)).filter((f) => f.endsWith(".md"));
const skillNames = readdirSync(join(root, skillsDir), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

/** The YAML frontmatter between the first two `---` lines, as raw lines. */
function frontmatter(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return [];
  const end = lines.indexOf("---", 1);
  return end === -1 ? [] : lines.slice(1, end);
}

/** The quoted globs listed under `paths:`. */
function pathsOf(text: string): string[] {
  const fm = frontmatter(text);
  const start = fm.findIndex((l) => l.trim() === "paths:");
  if (start === -1) return [];
  const globs: string[] = [];
  for (const line of fm.slice(start + 1)) {
    const m = /^\s+-\s+"([^"]+)"\s*$/.exec(line);
    if (m === null) break;
    globs.push(m[1]);
  }
  return globs;
}

/**
 * The glob subset the rules files use: `**` across directories, `*` inside one,
 * `{a,b}` alternatives. Anything fancier fails the "matches a tracked file"
 * test below rather than being silently misread.
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+?^$()[\]\\|]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

describe("CLAUDE.md", () => {
  it(`stays at or under ${CLAUDE_MD_MAX_LINES} lines`, () => {
    expect(claudeMd.split(/\r?\n/).length).toBeLessThanOrEqual(CLAUDE_MD_MAX_LINES);
  });

  it("routes to every rules file and every skill", () => {
    expect(ruleFiles.filter((f) => !claudeMd.includes(f))).toEqual([]);
    expect(skillNames.filter((s) => !claudeMd.includes(`\`${s}\``))).toEqual([]);
  });
});

describe("the glob reader", () => {
  it("reads the subset the rules files use", () => {
    expect(globToRegExp("src/app/**").test("src/app/trends/page.tsx")).toBe(true);
    expect(globToRegExp("**/*.test.ts").test("scripts/privacy.test.ts")).toBe(true);
    expect(globToRegExp("src/lib/ui/{repaid,trips}*.ts").test("src/lib/ui/trips.test.ts")).toBe(true);
    expect(globToRegExp("src/app/**/actions.ts").test("src/app/transactions/page.tsx")).toBe(false);
    expect(globToRegExp("scripts/*.ts").test("scripts/nested/x.ts")).toBe(false);
  });
});

describe.each(ruleFiles)(".claude/rules/%s", (file) => {
  const text = read(`${rulesDir}/${file}`);

  it("declares paths, and every glob still matches a tracked file", () => {
    const globs = pathsOf(text);
    expect(globs.length).toBeGreaterThan(0);
    const dead = globs.filter((g) => !tracked.some((f) => globToRegExp(g).test(f)));
    expect(dead).toEqual([]);
  });

  it("names an evidence file that exists", () => {
    const m = /Evidence: (docs\/conventions\/[\w-]+\.md)/.exec(text);
    expect(m).not.toBeNull();
    expect(existsSync(join(root, m![1]))).toBe(true);
  });
});

describe("docs/conventions", () => {
  it("every evidence file is named by a rules file", () => {
    const named = ruleFiles.map((f) => read(`${rulesDir}/${f}`)).join("\n");
    const orphans = readdirSync(join(root, "docs/conventions")).filter(
      (f) => f.endsWith(".md") && !named.includes(`docs/conventions/${f}`),
    );
    expect(orphans).toEqual([]);
  });
});

describe.each(skillNames)(".claude/skills/%s", (name) => {
  const text = read(`${skillsDir}/${name}/SKILL.md`);
  const fm = frontmatter(text);

  it("has a name matching its directory and a description", () => {
    expect(fm).toContain(`name: ${name}`);
    expect(fm.some((l) => /^description: \S/.test(l))).toBe(true);
  });

  it("points only at rules files that exist", () => {
    const cited = [...text.matchAll(/\.claude\/rules\/([\w-]+\.md)/g)].map((m) => m[1]);
    expect(cited.filter((f) => !ruleFiles.includes(f))).toEqual([]);
  });
});
