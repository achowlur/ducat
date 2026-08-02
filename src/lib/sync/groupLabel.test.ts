import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Connector,
  NormalizedAccount,
  NormalizedTransaction,
  SpendingByCategoryPayload,
} from "../../types/contracts";
import { PrismaClient } from "../../generated/prisma/client";
import { generateInsights } from "../insights/engine";
import { spendingBreakdown } from "../ui/spendingBreakdown";
import { reapplyRules, restoreTransactions } from "./rulePack";
import { runSync } from "./sync";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));

const LABEL = "Tess's March trip";

/**
 * THE FEATURE'S SPINE: a trip is a cross-period VIEW over real rows, never a
 * re-bucketing. Tagging rows with a groupLabel must change NOTHING any
 * analyzer or printed total reports — byte-identical insight output before
 * and after — and every path that rewrites rows (dedup re-import, rule
 * reapplication and its undo, transfer-pair detection) must leave the tag
 * standing, the same protection MANUAL categorization gets.
 */
describe("groupLabel is a view, never a re-bucketing", () => {
  let dir: string;
  let prisma: PrismaClient;

  class FakeConnector implements Connector {
    readonly type = "SIMPLEFIN";
    constructor(
      private accounts: NormalizedAccount[],
      private txns: NormalizedTransaction[],
    ) {}
    listAccounts(): Promise<NormalizedAccount[]> {
      return Promise.resolve(this.accounts);
    }
    fetchTransactions(since: Date): Promise<NormalizedTransaction[]> {
      return Promise.resolve(this.txns.filter((t) => t.date.getTime() >= since.getTime()));
    }
  }

  const accounts: NormalizedAccount[] = [
    {
      externalId: "ext-checking", connectorType: "SIMPLEFIN", institution: "Test Bank",
      name: "Checking", type: "DEPOSITORY", currency: "USD",
      balance: 4000, balanceDate: utc(2026, 4, 12), isStale: false,
    },
    {
      externalId: "ext-savings", connectorType: "SIMPLEFIN", institution: "Test Bank",
      name: "Savings", type: "DEPOSITORY", currency: "USD",
      balance: 9000, balanceDate: utc(2026, 4, 12), isStale: false,
    },
  ];
  const txn = (
    acct: string, externalId: string, date: Date, amount: number, merchant: string,
  ): NormalizedTransaction => ({
    accountExternalId: acct, externalId, date, amount,
    description: merchant.toUpperCase(), normalizedMerchant: merchant,
    flow: amount >= 0 ? "INFLOW" : "OUTFLOW", source: "SIMPLEFIN",
  });
  // Two months of activity so the trip is genuinely cross-period, with a
  // transfer pair, a future MANUAL row, and a future reimbursement link.
  const transactions = [
    txn("ext-checking", "t-salary-mar", utc(2026, 3, 1), 3000, "employer"),
    txn("ext-checking", "t-hotel", utc(2026, 3, 5), -600, "marriott"),
    txn("ext-checking", "t-dinner", utc(2026, 3, 6), -80, "chipotle"),
    txn("ext-checking", "t-repay", utc(2026, 3, 8), 40, "zelle from tess"),
    txn("ext-checking", "t-xfer-out", utc(2026, 3, 10), -500, "transfer to savings"),
    txn("ext-savings", "t-xfer-in", utc(2026, 3, 11), 500, "transfer from checking"),
    txn("ext-checking", "t-salary-apr", utc(2026, 4, 1), 3000, "employer"),
    txn("ext-checking", "t-groceries", utc(2026, 4, 3), -120, "kroger"),
  ];

  const byExternalId = (externalId: string) =>
    prisma.transaction.findFirstOrThrow({ where: { externalId } });

  /** Insight rows minus their regeneration-churned identity (id, createdAt). */
  const snapshotInsights = async () => {
    const rows = await prisma.insight.findMany();
    return rows
      .map(({ type, period, payload, dismissed }) => ({ type, period, payload, dismissed }))
      .sort((a, b) =>
        `${a.type}|${a.period}|${JSON.stringify(a.payload)}`.localeCompare(
          `${b.type}|${b.period}|${JSON.stringify(b.payload)}`,
        ),
      );
  };

  /** The key UI aggregate: every printed spending total flows through this. */
  const snapshotBreakdowns = async () => {
    const rows = await prisma.insight.findMany({ where: { type: "SPENDING_BY_CATEGORY" } });
    return rows
      .map((r) => ({
        period: r.period,
        breakdown: spendingBreakdown(r.payload as unknown as SpendingByCategoryPayload),
      }))
      .sort((a, b) => a.period.localeCompare(b.period));
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ducat-grouplabel-test-"));
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

    const travel = await prisma.category.create({ data: { name: "Travel" } });
    await prisma.category.create({ data: { name: "Dining" } });
    await prisma.rule.create({
      data: {
        priority: 10, matchField: "MERCHANT", matchOperator: "CONTAINS",
        matchValue: "marriott", setCategoryId: travel.id, enabled: true,
      },
    });

    await runSync(prisma, new FakeConnector(accounts, transactions), { since: utc(2026, 2, 20) });

    // A human's decisions, made after the sync: a MANUAL category and a
    // reimbursement link — both must sit in the baseline the invariant
    // compares against.
    const dining = await prisma.category.findFirstOrThrow({ where: { name: "Dining" } });
    const dinner = await byExternalId("t-dinner");
    await prisma.transaction.update({
      where: { id: dinner.id },
      data: { categoryId: dining.id, categorySource: "MANUAL" },
    });
    const repay = await byExternalId("t-repay");
    await prisma.transaction.update({ where: { id: repay.id }, data: { reimbursesId: dinner.id } });
    await generateInsights(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tagging rows changes NO analyzer output and no printed total — byte-identical", async () => {
    const before = await snapshotInsights();
    const breakdownsBefore = await snapshotBreakdowns();
    expect(before.length).toBeGreaterThan(0); // the comparison must be against something real
    // Which analyzers this snapshot EMPIRICALLY pins. The fixture is too
    // small to fire anomaly/recurring/subscription analyzers — those are
    // protected by the zero-reads-of-groupLabel grep discipline, not by this
    // byte-compare. If this set ever grows or shrinks, that boundary moved:
    // re-decide it, don't just update the list.
    expect([...new Set(before.map((r) => r.type))].sort()).toEqual([
      "CASH_FLOW_TREND",
      "NET_WORTH_GROWTH",
      "SPENDING_BY_CATEGORY",
    ]);

    // Tag across every row shape the ledger has: a RULE-categorized outflow,
    // a MANUAL row, BOTH sides of a transfer pair, a linked reimbursement,
    // and a second month's row — the cross-period point.
    for (const externalId of ["t-hotel", "t-dinner", "t-xfer-out", "t-xfer-in", "t-repay", "t-groceries"]) {
      const t = await byExternalId(externalId);
      await prisma.transaction.update({ where: { id: t.id }, data: { groupLabel: LABEL } });
    }
    const tagged = await prisma.transaction.findMany({ where: { groupLabel: LABEL } });
    expect(tagged).toHaveLength(6);
    expect(tagged.some((t) => t.flow === "TRANSFER")).toBe(true); // transfers CAN carry the tag

    await generateInsights(prisma);

    expect(await snapshotInsights()).toEqual(before);
    expect(await snapshotBreakdowns()).toEqual(breakdownsBefore);
  });

  it("dedup re-import preserves the tag: an existing row is skipped, never re-upserted", async () => {
    const result = await runSync(prisma, new FakeConnector(accounts, transactions), {
      since: utc(2026, 2, 20),
    });
    expect(result.transactionsImported).toBe(0);
    expect(result.transactionsSkipped).toBe(transactions.length);
    expect(await prisma.transaction.count({ where: { groupLabel: LABEL } })).toBe(6);
    // and the tagged transfer pair stayed a pair
    const out = await byExternalId("t-xfer-out");
    expect(out.flow).toBe("TRANSFER");
    expect(out.groupLabel).toBe(LABEL);
  });

  it("reapplyRules rewrites the category and leaves the tag; its undo restores the category and leaves the tag", async () => {
    const dining = await prisma.category.findFirstOrThrow({ where: { name: "Dining" } });
    const travel = await prisma.category.findFirstOrThrow({ where: { name: "Travel" } });
    // A higher-priority rule moves the tagged hotel row Travel → Dining.
    await prisma.rule.create({
      data: {
        priority: 5, matchField: "MERCHANT", matchOperator: "CONTAINS",
        matchValue: "marriott", setCategoryId: dining.id, enabled: true,
      },
    });
    const { restore } = await reapplyRules(prisma);

    const moved = await byExternalId("t-hotel");
    expect(moved.categoryId).toBe(dining.id);
    expect(moved.groupLabel).toBe(LABEL); // the rewrite never touches the tag

    // The undo writes the snapshot back — exactly categoryId/categorySource/
    // flow, which is why the snapshot does not carry groupLabel: a tag
    // applied between do and undo must survive the undo.
    await prisma.rule.deleteMany({ where: { priority: 5 } });
    await restoreTransactions(prisma, restore);

    const restored = await byExternalId("t-hotel");
    expect(restored.categoryId).toBe(travel.id);
    expect(restored.categorySource).toBe("RULE");
    expect(restored.groupLabel).toBe(LABEL);
  });

  it("transfer-pair detection rewrites flow and category but leaves the tag", async () => {
    const checking = await prisma.account.findFirstOrThrow({ where: { externalId: "ext-checking" } });
    const savings = await prisma.account.findFirstOrThrow({ where: { externalId: "ext-savings" } });
    const mk = (accountId: string, externalId: string, amount: number) =>
      prisma.transaction.create({
        data: {
          accountId, externalId, date: utc(2026, 4, 9), amount,
          description: "MOVE", normalizedMerchant: "move",
          flow: amount >= 0 ? "INFLOW" : "OUTFLOW", source: "SIMPLEFIN",
          categorySource: "AGGREGATOR", groupLabel: LABEL,
        },
      });
    await mk(checking.id, "t-pair-out", -75.25);
    await mk(savings.id, "t-pair-in", 75.25);

    await runSync(prisma, new FakeConnector(accounts, transactions), { since: utc(2026, 2, 20) });

    const out = await byExternalId("t-pair-out");
    const inn = await byExternalId("t-pair-in");
    expect(out.flow).toBe("TRANSFER");
    expect(out.transferPairId).toBe(inn.id);
    expect(out.groupLabel).toBe(LABEL); // the rewrite spared the tag
    expect(inn.groupLabel).toBe(LABEL);
  });
});
