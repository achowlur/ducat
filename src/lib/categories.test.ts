import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client';
import type { ActionResult } from './actionResult';
import {
  categoryNameProblem,
  createUserCategory,
  existingCategoryName,
  MAX_CATEGORY_NAME,
  normalizeCategoryName,
} from './categories';
import { deleteUserCategory, isPackCategory, renameUserCategory } from './categoryEdits';
import { generateInsights } from './insights/engine';
import { P2P_UNREVIEWED_NAME } from './p2p';
import { installRulePack, PACK_CATEGORIES, pendingPackRules, reapplyRules } from './sync/rulePack';

/** A migrated throwaway database with the rule pack installed. */
async function packedDatabase(): Promise<{ dir: string; prisma: PrismaClient }> {
  const dir = mkdtempSync(join(tmpdir(), 'ducat-categories-test-'));
  const url = `file:${join(dir, 'test.db').replace(/\\/g, '/')}`;
  const conn = await new PrismaBetterSqlite3({ url }).connect();
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of migrations) {
    await conn.executeScript(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
  }
  await conn.dispose();
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
  await installRulePack(prisma);
  return { dir, prisma };
}

/** The accepted half of a result; a refusal fails the test with its own words. */
function accepted<T extends object>(result: ActionResult<T>): T {
  if (!result.ok) throw new Error(`refused: ${result.message}`);
  return result;
}

describe('normalizeCategoryName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeCategoryName('  Pet   care ')).toBe('Pet care');
    expect(normalizeCategoryName('Pet\tcare')).toBe('Pet care');
  });

  it('is null when nothing is left', () => {
    expect(normalizeCategoryName('')).toBeNull();
    expect(normalizeCategoryName('   ')).toBeNull();
  });

  it('keeps the casing and punctuation that were typed', () => {
    expect(normalizeCategoryName('Kids & School')).toBe('Kids & School');
  });
});

describe('categoryNameProblem', () => {
  const existing = ['Groceries', 'Rent & Housing'];

  it('passes a new name', () => {
    expect(categoryNameProblem('Pet care', existing)).toBeNull();
  });

  it('refuses a name that exists, whatever its casing, and names the one that does', () => {
    expect(categoryNameProblem('groceries', existing)).toBe('“Groceries” already exists.');
    expect(categoryNameProblem('RENT & HOUSING', existing)).toBe('“Rent & Housing” already exists.');
    expect(existingCategoryName('groceries', existing)).toBe('Groceries');
  });

  it('refuses the names the app prints for things that are not categories', () => {
    for (const name of ['Uncategorized', 'other', 'TRANSFER', 'all', 'None', P2P_UNREVIEWED_NAME]) {
      expect(categoryNameProblem(name, existing), name).toMatch(/is taken/);
    }
  });

  it('refuses a name past the cap, and passes one at it', () => {
    expect(categoryNameProblem('x'.repeat(MAX_CATEGORY_NAME), existing)).toBeNull();
    expect(categoryNameProblem('x'.repeat(MAX_CATEGORY_NAME + 1), existing)).toMatch(/cap at/);
  });

  it('reserves no name the rule pack ships, or the pack could not install', () => {
    for (const name of PACK_CATEGORIES) expect(categoryNameProblem(name, []), name).toBeNull();
  });
});

describe('createUserCategory', () => {
  let dir: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ({ dir, prisma } = await packedDatabase());
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds a spending category beside the pack', async () => {
    const before = await prisma.category.count();
    const made = accepted(await createUserCategory(prisma, '  Pet   care ', false));

    expect(made).toMatchObject({ name: 'Pet care', isIncome: false, created: true });
    expect(await prisma.category.count()).toBe(before + 1);
    expect(await prisma.category.findUniqueOrThrow({ where: { id: made.id } })).toMatchObject({
      name: 'Pet care',
      isIncome: false,
    });
  });

  it('adds an income category as income', async () => {
    const made = accepted(await createUserCategory(prisma, 'Rental income', true));
    expect(made).toMatchObject({ name: 'Rental income', isIncome: true, created: true });
  });

  it('adopts an existing category instead of forking a case variant', async () => {
    const before = await prisma.category.count();
    const groceries = await prisma.category.findFirstOrThrow({ where: { name: 'Groceries' } });

    const made = await createUserCategory(prisma, 'gROCERIES', true);

    expect(made).toEqual({ ok: true, id: groceries.id, name: 'Groceries', isIncome: false, created: false });
    expect(await prisma.category.count()).toBe(before);
  });

  it('adopts its own earlier creation the same way', async () => {
    const first = accepted(await createUserCategory(prisma, 'Hobbies', false));
    const again = accepted(await createUserCategory(prisma, 'hobbies', false));
    expect(again.id).toBe(first.id);
    expect(again.created).toBe(false);
  });

  // Refused as a VALUE: a thrown message is replaced in production, so the
  // reason would never reach the picker (lib/actionResult.ts).
  it('refuses a reserved, overlong or empty name and writes nothing', async () => {
    const before = await prisma.category.count();
    expect(await createUserCategory(prisma, 'Other', false)).toEqual({
      ok: false,
      message: expect.stringMatching(/is taken/),
    });
    expect(await createUserCategory(prisma, 'x'.repeat(MAX_CATEGORY_NAME + 1), false)).toEqual({
      ok: false,
      message: expect.stringMatching(/cap at/),
    });
    expect(await createUserCategory(prisma, '   ', false)).toEqual({ ok: false, message: 'A category needs a name.' });
    expect(await prisma.category.count()).toBe(before);
  });

  it('leaves the rule pack installed and current', async () => {
    expect(await pendingPackRules(prisma)).toBe(0);
    const again = await installRulePack(prisma);
    expect(again.categoriesCreated).toBe(0);
    expect(again.rulesCreated).toBe(0);
    // Reinstalling the pack must not remove what the operator added.
    expect(await prisma.category.count({ where: { name: { in: ['Pet care', 'Rental income', 'Hobbies'] } } })).toBe(3);
  });

  it('is counted by the analyzers like any other category', async () => {
    const pet = await prisma.category.findFirstOrThrow({ where: { name: 'Pet care' } });
    const account = await prisma.account.create({
      data: {
        externalId: 'test-checking',
        connectorType: 'SIMPLEFIN',
        institution: 'Test Bank',
        name: 'Checking',
        type: 'DEPOSITORY',
        currency: 'USD',
        balance: 1000,
        balanceDate: new Date(Date.UTC(2026, 6, 20, 12)),
        isStale: false,
      },
    });
    await prisma.transaction.create({
      data: {
        accountId: account.id,
        externalId: 'vet-1',
        date: new Date(Date.UTC(2026, 6, 10, 12)),
        amount: -82.5,
        description: 'NORTHSIDE VETERINARY',
        normalizedMerchant: 'northside veterinary',
        flow: 'OUTFLOW',
        categoryId: pet.id,
        categorySource: 'MANUAL',
        source: 'SIMPLEFIN',
      },
    });
    await generateInsights(prisma);

    const row = await prisma.insight.findFirstOrThrow({ where: { type: 'SPENDING_BY_CATEGORY', period: '2026-07' } });
    const payload = row.payload as unknown as {
      totalSpending: number;
      categories: { categoryId: string | null; categoryName: string | null; spending: number }[];
    };
    expect(payload.totalSpending).toBe(82.5);
    expect(payload.categories).toEqual([
      expect.objectContaining({ categoryId: pet.id, categoryName: 'Pet care', spending: 82.5 }),
    ]);
  });
});

describe('renaming and deleting a category', () => {
  let dir: string;
  let prisma: PrismaClient;
  let checking: string;
  let brokerage: string;

  beforeAll(async () => {
    ({ dir, prisma } = await packedDatabase());
    const account = (externalId: string, type: 'DEPOSITORY' | 'INVESTMENT') =>
      prisma.account.create({
        data: {
          externalId,
          connectorType: 'SIMPLEFIN',
          institution: 'Test Bank',
          name: externalId,
          type,
          currency: 'USD',
          balance: 1000,
          balanceDate: new Date(Date.UTC(2026, 6, 20, 12)),
          isStale: false,
        },
      });
    checking = (await account('checking', 'DEPOSITORY')).id;
    brokerage = (await account('brokerage', 'INVESTMENT')).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  let seq = 0;
  /** A row in a category, as the operator or a rule put it there. */
  async function row(
    categoryId: string,
    categorySource: 'MANUAL' | 'RULE',
    merchant: string,
    accountId = checking,
  ): Promise<string> {
    seq += 1;
    const made = await prisma.transaction.create({
      data: {
        accountId,
        externalId: `row-${seq}`,
        date: new Date(Date.UTC(2026, 6, 10, 12)),
        amount: -20,
        description: merchant.toUpperCase(),
        normalizedMerchant: merchant,
        flow: 'OUTFLOW',
        categoryId,
        categorySource,
        source: 'SIMPLEFIN',
      },
    });
    return made.id;
  }

  async function userRule(matchValue: string, setCategoryId: string, setFlow: 'TRANSFER' | null = null) {
    return prisma.rule.create({
      data: { priority: 50, matchField: 'MERCHANT', matchOperator: 'CONTAINS', matchValue, setCategoryId, setFlow, enabled: true },
    });
  }

  const own = async (name: string) => accepted(await createUserCategory(prisma, name, false)).id;
  const named = (name: string) => prisma.category.findFirstOrThrow({ where: { name } });

  it('tells the pack categories from the operator’s own', () => {
    expect(isPackCategory('Groceries')).toBe(true);
    expect(isPackCategory('Rent & Housing')).toBe(true);
    expect(isPackCategory('groceries')).toBe(false);
    expect(isPackCategory('Pet care')).toBe(false);
  });

  it('renames an own category, a casing-only change included', async () => {
    const id = await own('Dinning out');
    expect(accepted(await renameUserCategory(prisma, id, '  Eating   out '))).toEqual({ ok: true, name: 'Eating out', changed: true });
    expect(accepted(await renameUserCategory(prisma, id, 'eating OUT'))).toEqual({ ok: true, name: 'eating OUT', changed: true });
    expect(accepted(await renameUserCategory(prisma, id, 'eating OUT'))).toEqual({ ok: true, name: 'eating OUT', changed: false });
    expect((await prisma.category.findUniqueOrThrow({ where: { id } })).name).toBe('eating OUT');
  });

  it('refuses a rename onto a taken name, pointing at delete for a merge', async () => {
    const id = await own('Snacks');
    const result = await renameUserCategory(prisma, id, 'GROCERIES');
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/“Groceries” already exists.*delete “Snacks”/) });
    expect((await prisma.category.findUniqueOrThrow({ where: { id } })).name).toBe('Snacks');
  });

  it('refuses to rename or delete a pack category, and writes nothing', async () => {
    const groceries = await named('Groceries');
    const dining = await named('Dining');
    const packFixed = { ok: false, message: expect.stringMatching(/rule pack/) };
    expect(await renameUserCategory(prisma, groceries.id, 'Food')).toEqual(packFixed);
    expect(await deleteUserCategory(prisma, groceries.id, dining.id)).toEqual(packFixed);
    expect(await deleteUserCategory(prisma, groceries.id, null)).toEqual(packFixed);
    expect((await named('Groceries')).id).toBe(groceries.id);
  });

  it('refuses a reserved or empty name, a missing category, and a move into itself or into nothing', async () => {
    const id = await own('Odds and ends');
    expect(await renameUserCategory(prisma, id, 'Other')).toEqual({ ok: false, message: expect.stringMatching(/is taken/) });
    expect(await renameUserCategory(prisma, id, '  ')).toEqual({ ok: false, message: 'A category needs a name.' });
    expect(await renameUserCategory(prisma, 'no-such-id', 'Fine')).toEqual({
      ok: false,
      message: expect.stringMatching(/no longer exists/),
    });
    expect(await deleteUserCategory(prisma, 'no-such-id', null)).toEqual({
      ok: false,
      message: expect.stringMatching(/no longer exists/),
    });
    expect(await deleteUserCategory(prisma, id, id)).toEqual({ ok: false, message: expect.stringMatching(/somewhere other than/) });
    expect(await deleteUserCategory(prisma, id, 'no-such-id')).toEqual({
      ok: false,
      message: expect.stringMatching(/no longer exists/),
    });
    expect((await prisma.category.findUniqueOrThrow({ where: { id } })).name).toBe('Odds and ends');
  });

  it('merges into another category: rows keep their source, rules follow', async () => {
    const gifts = await own('Gifts');
    const presents = await own('Presents');
    const manual = await row(presents, 'MANUAL', 'lantern pottery');
    const ruled = await row(presents, 'RULE', 'paper crane cards');
    const rule = await userRule('paper crane', presents);

    const result = accepted(await deleteUserCategory(prisma, presents, gifts));

    expect(result).toEqual({ ok: true, name: 'Presents', moved: 2, rulesMoved: 1, rulesRemoved: 0 });
    expect(await prisma.category.findUnique({ where: { id: presents } })).toBeNull();
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: manual } })).toMatchObject({
      categoryId: gifts,
      categorySource: 'MANUAL',
    });
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: ruled } })).toMatchObject({
      categoryId: gifts,
      categorySource: 'RULE',
    });
    expect((await prisma.rule.findUniqueOrThrow({ where: { id: rule.id } })).setCategoryId).toBe(gifts);
  });

  it('into Uncategorized: clears rows as "none" does, and removes a category-only rule so it cannot shadow the pack', async () => {
    const mistake = await own('Grocerys');
    const manual = await row(mistake, 'MANUAL', 'corner bakery');
    const ruled = await row(mistake, 'RULE', 'whole foods market');
    const enclosed = await row(mistake, 'MANUAL', 'dividend received', brokerage);
    const categoryOnly = await userRule('whole foods', mistake);
    const withFlow = await userRule('zz sweep', mistake, 'TRANSFER');

    const result = accepted(await deleteUserCategory(prisma, mistake, null));

    expect(result).toEqual({ ok: true, name: 'Grocerys', moved: 3, rulesMoved: 0, rulesRemoved: 1 });
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: manual } })).toMatchObject({
      categoryId: null,
      categorySource: 'AGGREGATOR',
    });
    // A closed box encloses a cleared row at once, as the picker's "none" does.
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: enclosed } })).toMatchObject({
      categoryId: null,
      categorySource: 'RULE',
      flow: 'TRANSFER',
    });
    expect(await prisma.rule.findUnique({ where: { id: categoryOnly.id } })).toBeNull();
    expect(await prisma.rule.findUniqueOrThrow({ where: { id: withFlow.id } })).toMatchObject({
      setCategoryId: null,
      setFlow: 'TRANSFER',
    });

    // The next rule pass reaches the cleared row and the PACK claims it; the
    // removed rule would have matched first and cleared it again.
    await reapplyRules(prisma);
    const groceries = await named('Groceries');
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: ruled } })).toMatchObject({
      categoryId: groceries.id,
      categorySource: 'RULE',
    });
  });

  it('leaves the rule pack installed and current', async () => {
    expect(await pendingPackRules(prisma)).toBe(0);
    const again = await installRulePack(prisma);
    expect(again.categoriesCreated).toBe(0);
    expect(await prisma.category.count({ where: { name: { in: ['Presents', 'Grocerys'] } } })).toBe(0);
  });
});
