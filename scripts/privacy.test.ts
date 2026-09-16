import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the boundary this repo crosses once: private instance -> public
 * source. It reads every TRACKED text file, line by line, and looks for the
 * shapes a real statement export or a real account leaves behind — a card
 * marker, a payment-rail reference code, an account-mask suffix, a personal
 * email address, a live cloud hostname, or the operator's own mail
 * provider named outright. It knows only PATTERNS and the small set of
 * values this project has declared synthetic; it holds no real value of
 * its own, which is what lets it run — and be read — safely in public.
 *
 * Every hit is collected into ONE assertion. A leak like this is a
 * repo-wide property, not a single line: reporting only the first would
 * mean fixing one file, rerunning, and finding the next one by hand, over
 * and over.
 */

const root = join(import.meta.dirname, "..");

const SKIP_FILES = new Set(["package-lock.json"]);

const BINARY_EXTENSIONS = new Set([
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".zip",
  ".db",
  ".sqlite",
  ".mp4",
]);

function trackedTextFiles(): string[] {
  const out = execSync("git ls-files", { cwd: root, encoding: "utf8" });
  return out
    .split(/\r?\n/)
    .filter((path) => path.length > 0)
    .filter((path) => !SKIP_FILES.has(path))
    .filter((path) => !BINARY_EXTENSIONS.has(extname(path).toLowerCase()));
}

// (a) A CARD marker naming any four digits other than the synthetic tail
// this project's fixtures use everywhere else.
const CARD_RE = /CARD\s+(\d{4})(?!\d)/gi;
const SYNTHETIC_CARD_TAIL = "1234";

// (b) A payment-rail reference code outside either synthetic shape: the
// WFCT series (WFCT + seven digits + one trailing character), or a short
// alphanumeric prefix followed by a run of three or more of the SAME
// letter. Two shapes, not one, because a code's leading prefix is not a
// safe discriminator by itself — the same prefix that marks a placeholder
// also occurs on real, non-synthetic codes.
const REF_CODE_RE = /REF\s*#\s*([0-9A-Za-z]+)/g;
const SYNTHETIC_REF_SHAPE_WFCT = /^WFCT\d{7}[0-9A-Z]$/;
const SYNTHETIC_REF_SHAPE_REPEATED_LETTER = /^[A-Z0-9]{0,4}([A-Z])\1{2,}$/;
const isSyntheticRefCode = (code: string) =>
  SYNTHETIC_REF_SHAPE_WFCT.test(code) || SYNTHETIC_REF_SHAPE_REPEATED_LETTER.test(code);

// (c) An account/card mask — "(dddd)", "...dddd", or the unicode-ellipsis
// form — whose four digits fall outside the synthetic 0001-0009 series.
// A parenthesised four-digit YEAR is exempt: that form alone reads as
// prose at least as often as it reads as an account suffix. Masks are
// required to sit apart from an identifier or a preceding "." so an
// ordinary function call — `toBe(5000)`, `axisMoney(6000)` — is never a
// mask in the first place.
const PAREN_MASK_RE = /(?<![\w.])\((\d{4})\)/g;
const ELLIPSIS_MASK_RE = /(?<!\d)(?:\.\.\.|…)(\d{4})(?!\d)/g;
const SYNTHETIC_MASK_SHAPE = /^000[1-9]$/;
const isFourDigitYear = (value: number) => value >= 1900 && value <= 2099;

// (d) Any email address other than the two this project documents as fine
// to ship: SimpleFIN's own public demo login, and anything at example.com.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SYNTHETIC_EMAIL = "demo@beta-bridge.simplefin.org";
const ALLOWED_EMAIL_DOMAIN_RE = /@example\.com$/i;

// (e) Any *.vercel.app hostname other than the doc placeholder — a real
// deployment hostname is exactly the kind of thing this test exists to
// keep out of a public repo.
const VERCEL_RE = /[A-Za-z0-9.-]+\.vercel\.app/g;
const PLACEHOLDER_VERCEL_HOST = "your-deployment.vercel.app";

// (f) The operator's own mail provider, named outright, anywhere.
const PERSONAL_MAIL_PROVIDER_RE = /gmail\.com/i;

function violationsInLine(path: string, lineNumber: number, line: string): string[] {
  const found: string[] = [];
  const flag = (reason: string) => found.push(`${path}:${lineNumber} — ${reason}`);

  for (const match of line.matchAll(CARD_RE)) {
    if (match[1] !== SYNTHETIC_CARD_TAIL) {
      flag(`CARD marker with non-synthetic digits (${match[1]})`);
    }
  }

  for (const match of line.matchAll(REF_CODE_RE)) {
    if (!isSyntheticRefCode(match[1])) {
      flag(`reference code after a REF marker, outside either synthetic shape (${match[1]})`);
    }
  }

  for (const match of line.matchAll(PAREN_MASK_RE)) {
    const digits = match[1];
    if (!SYNTHETIC_MASK_SHAPE.test(digits) && !isFourDigitYear(Number(digits))) {
      flag(`parenthesised account/card mask outside the synthetic series (${digits})`);
    }
  }

  for (const match of line.matchAll(ELLIPSIS_MASK_RE)) {
    const digits = match[1];
    if (!SYNTHETIC_MASK_SHAPE.test(digits)) {
      flag(`ellipsis account/card mask outside the synthetic series (${digits})`);
    }
  }

  for (const match of line.matchAll(EMAIL_RE)) {
    const email = match[0];
    if (email.toLowerCase() !== SYNTHETIC_EMAIL && !ALLOWED_EMAIL_DOMAIN_RE.test(email)) {
      flag(`email address other than the SimpleFIN demo login or example.com (${email})`);
    }
  }

  for (const match of line.matchAll(VERCEL_RE)) {
    const host = match[0];
    if (host !== PLACEHOLDER_VERCEL_HOST) {
      flag(`vercel.app hostname other than the doc placeholder (${host})`);
    }
  }

  if (PERSONAL_MAIL_PROVIDER_RE.test(line)) {
    flag("names the operator's personal mail provider");
  }

  return found;
}

describe("privacy", () => {
  it("ships no real card digits, rail reference codes, account masks, personal email, live cloud hostname, or mail provider", () => {
    const violations: string[] = [];

    for (const path of trackedTextFiles()) {
      let contents: string;
      try {
        contents = readFileSync(join(root, path), "utf8");
      } catch {
        continue; // not readable as UTF-8 text — nothing this test can check
      }
      contents.split(/\r?\n/).forEach((line, index) => {
        violations.push(...violationsInLine(path, index + 1, line));
      });
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
