import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/client";
import { reapplyRules } from "./rulePack";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

/**
 * The bulk review's undo depends on this: rules only ever WRITE, so removing
 * one leaves every row it already categorized exactly where it put them.
 * Reversal is only possible because reapplyRules hands back what each row
 * looked like first.
 */
describe("reapplyRules restore snapshot", () => {
  let dir: string;
  let prisma: PrismaClient;
  let diningId: string;
  let groceriesId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "finance-reapply-test-"));
    const url = `file:${join(dir, "test.db").replace(/\\/g, "/")}`;
    const factory = new PrismaBetterSqlite3({ url });
    const conn = await factory.connect();
    const migrationsDir = join(process.cwd(), "prisma", "migrations");
    for (const name of readdirSync(migrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      await conn.executeScript(readFileSync(join(migrationsDir, name, "migration.sql"), "utf8"));
    }
    await conn.dispose();
    prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

    const account = await prisma.account.create({
      data: {
        externalId: "acc-1", connectorType: "SIMPLEFIN", institution: "Test Bank",
        name: "Checking", type: "DEPOSITORY", currency: "USD",
        balance: 1000, balanceDate: utc(2026, 7, 12), isStale: false,
      },
    });
    diningId = (await prisma.category.create({ data: { name: "Dining" } })).id;
    groceriesId = (await prisma.category.create({ data: { name: "Groceries" } })).id;

    const txn = (externalId: string, categoryId: string | null, categorySource: "AGGREGATOR" | "MANUAL") =>
      prisma.transaction.create({
        data: {
          accountId: account.id, externalId, date: utc(2026, 7, 5), amount: -40,
          description: "ZELLE TO LENA ON 07/05", normalizedMerchant: "zelle to lena",
          flow: "OUTFLOW", source: "SIMPLEFIN", categoryId, categorySource,
        },
      });
    await txn("t-uncategorized", null, "AGGREGATOR");
    await txn("t-already-groceries", groceriesId, "AGGREGATOR");
    await txn("t-manual", diningId, "MANUAL");
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands back each row as it was, so a bulk decision can be reversed", async () => {
    await prisma.rule.create({
      data: {
        priority: 50, matchField: "DESCRIPTION", matchOperator: "CONTAINS",
        matchValue: "zelle to lena", setCategoryId: diningId, enabled: true,
      },
    });
    const { changed, restore } = await reapplyRules(prisma);

    // MANUAL is sacred and never enters the snapshot, because it was never touched.
    expect(changed).toBe(2);
    expect(restore.map((r) => r.categoryId).sort()).toEqual([groceriesId, null].sort());
    expect(restore.some((r) => r.categorySource === "MANUAL")).toBe(false);

    const after = await prisma.transaction.findMany({ orderBy: { externalId: "asc" } });
    expect(after.filter((t) => t.categoryId === diningId)).toHaveLength(3); // two by rule, one already manual

    // Undo: drop the rule and write the snapshot back.
    await prisma.rule.deleteMany({});
    for (const t of restore) {
      await prisma.transaction.update({
        where: { id: t.id },
        data: { categoryId: t.categoryId, categorySource: t.categorySource, flow: t.flow },
      });
    }

    const reverted = await prisma.transaction.findMany({ orderBy: { externalId: "asc" } });
    expect(reverted.map((t) => [t.externalId, t.categoryId, t.categorySource])).toEqual([
      ["t-already-groceries", groceriesId, "AGGREGATOR"],
      ["t-manual", diningId, "MANUAL"],
      ["t-uncategorized", null, "AGGREGATOR"],
    ]);
  });

  it("captures a flow rewrite too, so marking a payee TRANSFER is reversible", async () => {
    await prisma.rule.create({
      data: {
        priority: 50, matchField: "DESCRIPTION", matchOperator: "CONTAINS",
        matchValue: "zelle to lena", setCategoryId: null, setFlow: "TRANSFER", enabled: true,
      },
    });
    const { restore } = await reapplyRules(prisma);
    expect(restore.every((r) => r.flow === "OUTFLOW")).toBe(true);

    const marked = await prisma.transaction.findMany({ where: { flow: "TRANSFER" } });
    expect(marked).toHaveLength(2); // the MANUAL row is left alone here as well

    await prisma.rule.deleteMany({});
    for (const t of restore) {
      await prisma.transaction.update({
        where: { id: t.id },
        data: { categoryId: t.categoryId, categorySource: t.categorySource, flow: t.flow },
      });
    }
    expect(await prisma.transaction.count({ where: { flow: "TRANSFER" } })).toBe(0);
  });
});
