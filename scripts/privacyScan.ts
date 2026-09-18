/**
 * The shapes a real statement export or a real account leaves behind, and
 * the small set of values this project has declared synthetic. Shared by
 * the two guards on the public boundary: privacy.test.ts, which reads every
 * tracked file, and check-public-text.ts, which reads what never lands in a
 * file — commit messages, commit identities, the branch name, and a pull
 * request's title and description.
 *
 * It knows only PATTERNS. It cannot tell a scaled amount, a fictional name
 * or an invented merchant from a real one; those rest on the publishing rule
 * in CLAUDE.md. It holds no real value of its own, which is what lets it run
 * — and be read — safely in public.
 */

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

// (d) Any email address other than the ones that identify no person:
// SimpleFIN's public demo login, anything at example.com, GitHub's per-user
// no-reply addresses and its shared web-merge committer, and the
// Co-Authored-By trailer Claude Code writes.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAILS = new Set([
  "demo@beta-bridge.simplefin.org",
  "noreply@github.com",
  "noreply@anthropic.com",
]);
const ALLOWED_EMAIL_DOMAIN_RE = /@example\.com$/i;
const GITHUB_NO_REPLY_RE = /^\d+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$/i;

// (e) Any *.vercel.app hostname other than the doc placeholder and the
// PUBLIC DEMO — a real deployment hostname is exactly the kind of thing this
// guard exists to keep out of a public repo. The demo is published on
// purpose: it holds only invented data, prints its own password, and resets
// nightly (DUCAT_DEMO_PASSWORD, src/lib/demo/mode.ts). It is named exactly,
// never by pattern, so no other deployment can pass for it.
const VERCEL_RE = /[A-Za-z0-9.-]+\.vercel\.app/g;
const PLACEHOLDER_VERCEL_HOST = "your-deployment.vercel.app";
export const PUBLIC_DEMO_HOST = "ducat-demo.vercel.app";

// (f) The operator's own mail provider, named outright, anywhere.
const PERSONAL_MAIL_PROVIDER_RE = /gmail\.com/i;

const isAllowedEmail = (email: string) =>
  ALLOWED_EMAILS.has(email.toLowerCase()) ||
  ALLOWED_EMAIL_DOMAIN_RE.test(email) ||
  GITHUB_NO_REPLY_RE.test(email);

/**
 * A commit's author or committer email may only be an address that names no
 * one: a GitHub no-reply address, or GitHub's shared web-merge committer. A
 * web merge on an account without email privacy signs with the account's
 * personal address — which is how one reached public history on the day
 * this repository was published.
 */
export function isNoReplyIdentity(email: string): boolean {
  return GITHUB_NO_REPLY_RE.test(email) || email.toLowerCase() === "noreply@github.com";
}

/** Every reason one line of public text trips a guard; empty when clean. */
export function violationsInLine(line: string): string[] {
  const found: string[] = [];

  for (const match of line.matchAll(CARD_RE)) {
    if (match[1] !== SYNTHETIC_CARD_TAIL) {
      found.push(`CARD marker with non-synthetic digits (${match[1]})`);
    }
  }

  for (const match of line.matchAll(REF_CODE_RE)) {
    if (!isSyntheticRefCode(match[1])) {
      found.push(`reference code after a REF marker, outside either synthetic shape (${match[1]})`);
    }
  }

  for (const match of line.matchAll(PAREN_MASK_RE)) {
    const digits = match[1];
    if (!SYNTHETIC_MASK_SHAPE.test(digits) && !isFourDigitYear(Number(digits))) {
      found.push(`parenthesised account/card mask outside the synthetic series (${digits})`);
    }
  }

  for (const match of line.matchAll(ELLIPSIS_MASK_RE)) {
    const digits = match[1];
    if (!SYNTHETIC_MASK_SHAPE.test(digits)) {
      found.push(`ellipsis account/card mask outside the synthetic series (${digits})`);
    }
  }

  for (const match of line.matchAll(EMAIL_RE)) {
    if (!isAllowedEmail(match[0])) {
      found.push(`email address that is not a no-reply, demo or example.com address (${match[0]})`);
    }
  }

  for (const match of line.matchAll(VERCEL_RE)) {
    if (match[0] !== PLACEHOLDER_VERCEL_HOST && match[0] !== PUBLIC_DEMO_HOST) {
      found.push(`vercel.app hostname other than the doc placeholder or the public demo (${match[0]})`);
    }
  }

  if (PERSONAL_MAIL_PROVIDER_RE.test(line)) {
    found.push("names the operator's personal mail provider");
  }

  return found;
}

/**
 * Scans a block of text line by line, reporting each hit as
 * "<label>:<line> — <reason>" so every violation in a run is listed at once.
 */
export function scanText(label: string, text: string): string[] {
  const violations: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const reason of violationsInLine(line)) {
      violations.push(`${label}:${index + 1} — ${reason}`);
    }
  });
  return violations;
}
