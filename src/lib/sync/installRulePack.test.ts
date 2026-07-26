import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/client";
import { installRulePack, PACK_CATEGORIES, PACK_RULES } from "./rulePack";

/** A migrated, empty database in a temp directory. */
async function freshDb(): Promise<{ dir: string; prisma: PrismaClient }> {
  const dir = mkdtempSync(join(tmpdir(), "finance-pack-test-"));
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
  return { dir, prisma: new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) }) };
}

describe("installRulePack", () => {
  let dir: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ({ dir, prisma } = await freshDb());
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

/**
 * The pack against stored rows, not just the matcher: installing it
 * retroactively rewrites what is already in the database, which is the part
 * that has to be right before it runs against real money.
 */
describe("installRulePack: retroactive categorization", () => {
  let dir: string;
  let prisma: PrismaClient;
  let manualId: string;

  beforeAll(async () => {
    ({ dir, prisma } = await freshDb());

    const checking = await prisma.account.create({
      data: {
        externalId: "acct-checking",
        connectorType: "SIMPLEFIN",
        institution: "Wells Fargo",
        name: "Primary Checking",
        type: "DEPOSITORY",
        currency: "USD",
        balance: 4200,
        balanceDate: new Date("2026-07-20"),
        isStale: false,
      },
    });
    const brokerage = await prisma.account.create({
      data: {
        externalId: "acct-brokerage",
        connectorType: "CSV",
        institution: "Fidelity",
        name: "Individual",
        type: "INVESTMENT",
        currency: "USD",
        balance: 90_000,
        balanceDate: new Date("2026-07-20"),
        isStale: false,
      },
    });
    // Pre-existing category so a MANUAL row can point somewhere real.
    const dining = await prisma.category.create({ data: { name: "Dining" } });

    const row = (
      accountId: string,
      externalId: string,
      amount: number,
      description: string,
      normalizedMerchant: string,
      flow: "INFLOW" | "OUTFLOW",
    ) => ({
      accountId,
      externalId,
      date: new Date("2026-07-14"),
      amount,
      description,
      normalizedMerchant,
      flow,
      categorySource: "AGGREGATOR" as const,
      source: (accountId === brokerage.id ? "CSV" : "SIMPLEFIN") as "CSV" | "SIMPLEFIN",
    });

    await prisma.transaction.createMany({
      data: [
        row(checking.id, "t-card-pay", -812.44, "CHASE CREDIT CRD EPAY       260321 0000000000      JANE DOE", "chase credit crd epay jane doe", "OUTFLOW"),
        row(checking.id, "t-atm", -100, "ATM WITHDRAWAL                 AUTHORIZED ON   07/09 100 MAIN ST    ATM ID 0001A    CARD 1234", "atm withdrawal authorized on 100 main st atm id 0001a card 1234", "OUTFLOW"),
        row(checking.id, "t-tax", -2_140, "IRS              USATAXPYMT 041226 000000000000000 JANE H DOE", "irs usataxpymt jane h doe", "OUTFLOW"),
        row(checking.id, "t-rent", -2_350, "KEYSTONE PROPERTY MANAGEMENT ONLINE PMT", "keystone property management online pmt", "OUTFLOW"),
        row(brokerage.id, "t-dividend", 61.18, "DIVIDEND RECEIVED FIDELITY 500 INDEX FUND (FZZAX) (Cash)", "dividend", "INFLOW"),
        row(checking.id, "t-unknown", -46.2, "BOBS HARDWARE FAIRVIEW IL", "bobs hardware fairview il", "OUTFLOW"),
      ],
    });
    // A human already decided this one was Dining, and it is also an exact
    // match for the new ATM rule — the collision is the point.
    const manual = await prisma.transaction.create({
      data: {
        ...row(checking.id, "t-manual-atm", -60, "ATM WITHDRAWAL AUTHORIZED ON 07/02 MAIN ST    ATM ID 0001A    CARD 1234", "atm withdrawal authorized on main st atm id 0001a card 1234", "OUTFLOW"),
        categoryId: dining.id,
        categorySource: "MANUAL",
      },
    });
    manualId = manual.id;

    await installRulePack(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const categorized = async (externalId: string) => {
    const t = await prisma.transaction.findFirstOrThrow({
      where: { externalId },
      include: { category: { select: { name: true } } },
    });
    return { category: t.category?.name ?? null, flow: t.flow, source: t.categorySource };
  };

  it("marks a credit-card payment as a TRANSFER carrying no category", async () => {
    expect(await categorized("t-card-pay")).toEqual({ category: null, flow: "TRANSFER", source: "RULE" });
  });

  it("files ATM cash, taxes, rent and brokerage income into the shipped categories", async () => {
    expect((await categorized("t-atm")).category).toBe("Cash & ATM");
    expect((await categorized("t-tax")).category).toBe("Taxes");
    expect((await categorized("t-rent")).category).toBe("Rent & Housing");
    expect((await categorized("t-dividend")).category).toBe("Income");
  });

  it("leaves an unrecognized merchant uncategorized rather than guessing", async () => {
    expect(await categorized("t-unknown")).toEqual({ category: null, flow: "OUTFLOW", source: "AGGREGATOR" });
  });

  it("never overwrites a MANUAL categorization, even on an exact rule match", async () => {
    const manual = await prisma.transaction.findUniqueOrThrow({
      where: { id: manualId },
      include: { category: { select: { name: true } } },
    });
    expect(manual.category?.name).toBe("Dining");
    expect(manual.categorySource).toBe("MANUAL");
    expect(manual.flow).toBe("OUTFLOW");
  });

  it("reports exactly the rows it rewrote", async () => {
    // Re-running changes nothing: every row already sits where the rules put
    // it, so the count is the honest blast radius of a second install.
    expect((await installRulePack(prisma)).transactionsRecategorized).toBe(0);
  });
});
