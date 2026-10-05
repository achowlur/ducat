/**
 * Renaming and deleting the operator's own categories: the server half of
 * categories.ts. Kept apart because categories.ts is imported by the picker
 * in the browser, and these reach the rule pack and the closed box, which
 * must not travel with it. The naming rules stay in categories.ts, so a
 * rename is held to exactly the rules a creation is.
 */
import type { PrismaClient } from '../generated/prisma/client';
import { refuse, type ActionResult } from './actionResult';
import { categoryNameProblem, existingCategoryName, normalizeCategoryName } from './categories';
import { isClosedBox, whenCleared } from './sync/closedBox';
import { PACK_CATEGORIES } from './sync/rulePack';

/**
 * Whether a category is one the rule pack ships. Those keep their names: the
 * pack finds its categories BY NAME on every install (a renamed one would be
 * made again, empty, beside it), and the app reads several by name
 * (readiness' housing, the subscription detector's exclusions, the
 * reimbursement ranker's unsplittables, Income's isIncome). So renaming and
 * deleting are for the operator's own categories only.
 */
export function isPackCategory(name: string): boolean {
  return (PACK_CATEGORIES as readonly string[]).includes(name);
}

const PACK_FIXED =
  'The rule pack’s categories keep their names: the pack and the app find them by name.';
const GONE = 'That category no longer exists. Reload to see the current list.';

/**
 * Rename one of the operator's own categories. Refuses, as a value, a pack
 * category, a name that cannot be a category, and a name another category
 * already carries in any casing: a rename never MERGES (the trip rename
 * does, warned), because a category merge moves rules as well as rows and
 * belongs to delete, which says so before it writes. Changing only the
 * casing of its own name is allowed.
 *
 * Writes the name and nothing else; the caller regenerates insights, whose
 * payloads carry category names.
 */
export async function renameUserCategory(
  prisma: PrismaClient,
  id: string,
  rawName: string,
): Promise<ActionResult<{ name: string; changed: boolean }>> {
  const name = normalizeCategoryName(rawName);
  if (name === null) return refuse('A category needs a name.');
  const all = await prisma.category.findMany({ select: { id: true, name: true } });
  const target = all.find((c) => c.id === id);
  if (target === undefined) return refuse(GONE);
  if (isPackCategory(target.name)) return refuse(PACK_FIXED);
  if (name === target.name) return { ok: true, name, changed: false };
  const others = all.filter((c) => c.id !== id).map((c) => c.name);
  const taken = existingCategoryName(name, others);
  if (taken !== null) {
    return refuse(`“${taken}” already exists. To fold “${target.name}” into it, delete “${target.name}” and move its rows there.`);
  }
  const problem = categoryNameProblem(name, others);
  if (problem !== null) return refuse(problem);
  await prisma.category.update({ where: { id }, data: { name } });
  return { ok: true, name, changed: true };
}

/**
 * Delete one of the operator's own categories, moving everything that points
 * at it first, in one batch, so nothing is ever left pointing at nothing.
 *
 * INTO ANOTHER CATEGORY (`moveTo` an id) it is a merge: every row moves with
 * its categorySource intact (a MANUAL row stays the operator's decision, now
 * spelled with the other name) and every rule that set this category sets
 * that one, so the rows a rule put here are still that rule's.
 *
 * INTO UNCATEGORIZED (`moveTo` null) every row is CLEARED by the same write
 * the picker's "none" makes (whenCleared): back to the review queue, or, in a
 * closed box, a transfer by its account's type. A rule that set only this
 * category is REMOVED, because a rule left setting no category and no flow
 * still matches first and clears every row it reaches, shadowing the pack
 * beneath it; a rule that also sets a flow keeps the flow.
 *
 * Rows are moved rather than left to the foreign key's SET NULL, which would
 * strand them as uncategorized under their old source and turn each rule
 * into exactly that shadowing rule. The caller regenerates insights.
 */
export async function deleteUserCategory(
  prisma: PrismaClient,
  id: string,
  moveTo: string | null,
): Promise<ActionResult<{ name: string; moved: number; rulesMoved: number; rulesRemoved: number }>> {
  const [all, accounts] = await Promise.all([
    prisma.category.findMany({ select: { id: true, name: true } }),
    prisma.account.findMany({ select: { id: true, type: true } }),
  ]);
  const target = all.find((c) => c.id === id);
  if (target === undefined) return refuse(GONE);
  if (isPackCategory(target.name)) return refuse(PACK_FIXED);
  if (moveTo === id) return refuse(`Choose somewhere other than “${target.name}” for its rows.`);
  if (moveTo !== null && !all.some((c) => c.id === moveTo)) {
    return refuse('The category chosen for its rows no longer exists. Reload to see the current list.');
  }

  const children = prisma.category.updateMany({ where: { parentId: id }, data: { parentId: null } });
  const remove = prisma.category.delete({ where: { id } });
  if (moveTo !== null) {
    const [rows, rules] = await prisma.$transaction([
      prisma.transaction.updateMany({ where: { categoryId: id }, data: { categoryId: moveTo } }),
      prisma.rule.updateMany({ where: { setCategoryId: id }, data: { setCategoryId: moveTo } }),
      children,
      remove,
    ]);
    return { ok: true, name: target.name, moved: rows.count, rulesMoved: rules.count, rulesRemoved: 0 };
  }

  const closed = accounts.filter((a) => isClosedBox(a.type));
  const [enclosed, cleared, removed] = await prisma.$transaction([
    prisma.transaction.updateMany({
      where: { categoryId: id, accountId: { in: closed.map((a) => a.id) } },
      data: whenCleared(closed[0]?.type),
    }),
    prisma.transaction.updateMany({ where: { categoryId: id }, data: whenCleared(null) }),
    prisma.rule.deleteMany({ where: { setCategoryId: id, setFlow: null } }),
    prisma.rule.updateMany({ where: { setCategoryId: id }, data: { setCategoryId: null } }),
    children,
    remove,
  ]);
  return {
    ok: true,
    name: target.name,
    moved: enclosed.count + cleared.count,
    rulesMoved: 0,
    rulesRemoved: removed.count,
  };
}
