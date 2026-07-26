import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/client";
import { installRulePack, PACK_CATEGORIES, PACK_RULES } from "./rulePack";

describe("installRulePack", () => {
  let dir: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "finance-pack-test-"));
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
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs every category and rule, then is a no-op on a second run", async () => {
    const first = await installRulePack(prisma);
    expect(first.categoriesCreated).toBe(PACK_CATEGORIES.length);
    expect(first.rulesCreated).toBe(PACK_RULES.length);
    expect(first.rulesSkipped).toBe(0);

    // Idempotence is the property that lets this be re-run after an upgrade.
    const second = await installRulePack(prisma);
    expect(second.categoriesCreated).toBe(0);
    expect(second.rulesCreated).toBe(0);
    expect(second.rulesSkipped).toBe(PACK_RULES.length);
    expect(await prisma.rule.count()).toBe(PACK_RULES.length);
    expect(await prisma.category.count()).toBe(PACK_CATEGORIES.length);
  });

  it("points every categorizing rule at a real category, and flow-only rules at none", async () => {
    const rules = await prisma.rule.findMany({ include: { setCategory: true } });
    for (const r of rules) {
      const packRule = PACK_RULES.find(
        (p) => p.matchField === r.matchField && p.matchOperator === r.matchOperator && p.matchValue === r.matchValue,
      );
      expect(packRule).toBeDefined();
      if (packRule?.category === null) {
        expect(r.setCategoryId).toBeNull();
        expect(r.setFlow).toBe("TRANSFER");
      } else {
        expect(r.setCategory?.name).toBe(packRule?.category);
      }
    }
  });

  it("promotes a pre-existing Income category rather than duplicating it", async () => {
    // A fresh clone may already have "Income" as an ordinary spending
    // category; the pack has to fix the flag, not create a second row.
    await prisma.rule.deleteMany({});
    await prisma.category.deleteMany({});
    await prisma.category.create({ data: { name: "Income", isIncome: false } });

    const result = await installRulePack(prisma);
    expect(result.categoriesCreated).toBe(PACK_CATEGORIES.length - 1);
    const income = await prisma.category.findMany({ where: { name: "Income" } });
    expect(income).toHaveLength(1);
    expect(income[0].isIncome).toBe(true);
  });
});
