/**
 * Categories the operator adds for themselves.
 *
 * The rule pack ships a fixed list (PACK_CATEGORIES), and until this existed
 * that list was every category an instance could have: nothing in the app, no
 * script and no documented step created another. A category is a ROW, so one
 * added here is local to the database it was added to. It travels with no
 * release, and a release changes nothing about it.
 *
 * The naming rules live here, outside ui/, because two callers must agree on
 * them to the character: the picker deciding whether to OFFER a name, and the
 * action deciding whether to WRITE it. The action does not trust the picker.
 */
import type { PrismaClient } from '../generated/prisma/client';
import { P2P_UNREVIEWED_NAME } from './p2p';

/** Long enough for "Home improvement & repairs"; short enough for the ledger's category cell. */
export const MAX_CATEGORY_NAME = 40;

/**
 * Names the app already prints for something that is NOT a category. A real
 * category wearing one would put two rows of the same name on a screen with
 * no way to tell which is which.
 */
const RESERVED: { name: string; because: string }[] = [
  { name: 'Uncategorized', because: 'it is what rows with no category are called' },
  { name: P2P_UNREVIEWED_NAME, because: 'it is what payments waiting for confirmation are called' },
  { name: 'Other', because: "it is the chart's name for everything it does not list" },
  { name: 'Transfer', because: 'a transfer is a flow, not a category' },
  { name: 'All', because: "it is the filter's name for no filter" },
  { name: 'None', because: "it is the picker's name for clearing a category" },
];

/**
 * Canonical form: trimmed, runs of whitespace collapsed, so two names can
 * never differ by a space nobody can see. Null when nothing is left.
 */
export function normalizeCategoryName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim();
  return name === '' ? null : name;
}

const fold = (name: string) => name.toLowerCase();

/** The existing name this one collides with, whatever its casing; null when it is new. */
export function existingCategoryName(name: string, existing: readonly string[]): string | null {
  return existing.find((e) => fold(e) === fold(name)) ?? null;
}

/**
 * Why a name cannot become a category, in words for the person who typed it;
 * null when it can. Takes the NORMALIZED name.
 */
export function categoryNameProblem(name: string, existing: readonly string[]): string | null {
  if (name.length > MAX_CATEGORY_NAME) return `Category names cap at ${MAX_CATEGORY_NAME} characters.`;
  const reserved = RESERVED.find((r) => fold(r.name) === fold(name));
  if (reserved !== undefined) return `“${reserved.name}” is taken: ${reserved.because}.`;
  const taken = existingCategoryName(name, existing);
  if (taken !== null) return `“${taken}” already exists.`;
  return null;
}

/**
 * Create a category, or return the one already carrying the name.
 *
 * ADOPTS rather than refuses on a collision, casing included: the picker's
 * list can be stale against another tab, and what must not happen is a second
 * "groceries" beside "Groceries". An adopted category keeps its own `isIncome`.
 *
 * No insight is regenerated: a category with no transaction changes no total.
 */
export async function createUserCategory(
  prisma: PrismaClient,
  rawName: string,
  isIncome: boolean,
): Promise<{ id: string; name: string; isIncome: boolean; created: boolean }> {
  const name = normalizeCategoryName(rawName);
  if (name === null) throw new Error('A category needs a name.');
  const all = await prisma.category.findMany({ select: { id: true, name: true, isIncome: true } });
  const taken = all.find((c) => fold(c.name) === fold(name));
  if (taken !== undefined) return { ...taken, created: false };
  const problem = categoryNameProblem(name, []);
  if (problem !== null) throw new Error(problem);
  const row = await prisma.category.create({ data: { name, isIncome } });
  return { id: row.id, name: row.name, isIncome: row.isIncome, created: true };
}
