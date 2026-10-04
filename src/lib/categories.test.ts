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
import { generateInsights } from './insights/engine';
import { P2P_UNREVIEWED_NAME } from './p2p';
import { installRulePack, PACK_CATEGORIES, pendingPackRules } from './sync/rulePack';

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
    dir = mkdtempSync(join(tmpdir(), 'ducat-categories-test-'));
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
    prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
    await installRulePack(prisma);
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
