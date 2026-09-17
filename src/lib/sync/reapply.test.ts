import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/client";
import { confirmP2PMatches, reapplyRules, restoreTransactions } from "./rulePack";

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
    dir = mkdtempSync(join(tmpdir(), "ducat-reapply-test-"));
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
          description: "ZELLE TO JANE DOE ON 07/05", normalizedMerchant: "zelle to jane doe",
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

  it("writes nothing when a P2P payee's rule assigns a CATEGORY — that is only a suggestion now", async () => {
    await prisma.rule.create({
      data: {
        priority: 50, matchField: "DESCRIPTION", matchOperator: "CONTAINS",
        matchValue: "zelle to jane doe", setCategoryId: diningId, enabled: true,
      },
    });
    const { changed, restore } = await reapplyRules(prisma);
    expect(changed).toBe(0);
    expect(restore).toEqual([]);
    await prisma.rule.deleteMany({});
  });

  it("confirms the payee's WAITING payments when a person makes the decision, and the snapshot reverses it", async () => {
    const restore = await confirmP2PMatches(prisma, {
      matchField: "DESCRIPTION", matchOperator: "CONTAINS", matchValue: "zelle to jane doe",
      setCategoryId: diningId, setFlow: null,
    });

    // Only the row waiting for review: the one already categorized keeps its
    // category, and the MANUAL one was never waiting.
    expect(restore.map((r) => [r.categoryId, r.categorySource])).toEqual([[null, "AGGREGATOR"]]);
    const after = await prisma.transaction.findMany({ orderBy: { externalId: "asc" } });
    expect(after.map((t) => [t.externalId, t.categoryId, t.categorySource])).toEqual([
      ["t-already-groceries", groceriesId, "AGGREGATOR"],
      ["t-manual", diningId, "MANUAL"],
      ["t-uncategorized", diningId, "MANUAL"], // a person decided
    ]);

    await restoreTransactions(prisma, restore);
    const reverted = await prisma.transaction.findMany({ orderBy: { externalId: "asc" } });
    expect(reverted.map((t) => [t.externalId, t.categoryId, t.categorySource])).toEqual([
      ["t-already-groceries", groceriesId, "AGGREGATOR"],
      ["t-manual", diningId, "MANUAL"],
      ["t-uncategorized", null, "AGGREGATOR"],
    ]);
  });

  it("confirms nothing for a TRANSFER decision, which the rule itself applies", async () => {
    const restore = await confirmP2PMatches(prisma, {
      matchField: "DESCRIPTION", matchOperator: "CONTAINS", matchValue: "zelle to jane doe",
      setCategoryId: null, setFlow: "TRANSFER",
    });
    expect(restore).toEqual([]);
  });

  it("captures a flow rewrite too, so marking a payee TRANSFER is reversible", async () => {
    await prisma.rule.create({
      data: {
        priority: 50, matchField: "DESCRIPTION", matchOperator: "CONTAINS",
        matchValue: "zelle to jane doe", setCategoryId: null, setFlow: "TRANSFER", enabled: true,
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
