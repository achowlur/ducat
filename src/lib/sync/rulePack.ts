import type { PrismaClient } from "../../generated/prisma/client";
import { generateInsights } from "../insights/engine";
import { applyRules, type RuleTxn } from "./rules";

/**
 * Starter categorization pack: brand rules and generic-word heuristics,
 * installed as ORDINARY Rule rows so everything stays visible, editable,
 * and overridable. No hidden code path decides a category.
 *
 * Priority bands (lower wins, first match applies):
 *   1-99    user rules — always beat the pack, and are the ONLY rules
 *           allowed to categorize P2P payments (see rules.ts P2P guard)
 *   500-599 brand patterns (specific merchants)
 *   900-999 generic-word heuristics (last resort before uncategorized)
 */

export { P2P_PATTERN } from "./rules";

/** Categories the pack targets. Installed idempotently by name. */
export const PACK_CATEGORIES = [
  "Groceries",
  "Dining",
  "Gas",
  "Shopping",
  "Subscriptions",
  "Utilities",
  "Transport",
  "Travel",
  "Health",
  "Entertainment",
  "Fees & Charges",
  "Income",
] as const;

export interface PackRule {
  priority: number;
  matchField: "MERCHANT" | "DESCRIPTION";
  matchOperator: "CONTAINS" | "REGEX";
  matchValue: string;
  category: (typeof PACK_CATEGORIES)[number];
}

const contains = (
  priority: number,
  category: PackRule["category"],
  ...values: string[]
): PackRule[] => values.map((matchValue) => ({ priority, matchField: "MERCHANT", matchOperator: "CONTAINS", matchValue, category }));

const regex = (
  priority: number,
  category: PackRule["category"],
  matchValue: string,
  matchField: PackRule["matchField"] = "MERCHANT",
): PackRule => ({ priority, matchField, matchOperator: "REGEX", matchValue, category });

export const PACK_RULES: PackRule[] = [
  // --- Brands: order-sensitive pairs first (more specific = lower number)
  ...contains(500, "Dining", "uber eats", "ubereats", "doordash", "grubhub", "postmates"),
  ...contains(510, "Transport", "uber", "lyft"),
  ...contains(500, "Subscriptions", "amazon prime", "prime video", "audible"),
  ...contains(510, "Shopping", "amazon", "amzn"),
  ...contains(500, "Gas", "kroger fuel", "safeway fuel", "costco gas"),
  ...contains(510, "Groceries", "kroger", "safeway", "albertsons", "aldi", "trader joe", "whole foods", "wholefds", "wegmans", "publix", "food lion", "giant eagle", "sprouts", "winco", "costco", "sam's club", "wm supercenter", "walmart", "wal-mart", "instacart", "h-e-b", "heb #"),

  ...contains(520, "Dining", "mcdonald", "chipotle", "starbucks", "dunkin", "subway", "taco bell", "chick-fil-a", "wendy", "burger king", "domino", "pizza hut", "papa john", "panera", "five guys", "in-n-out", "shake shack", "kfc", "popeyes", "olive garden", "applebee", "chili's", "ihop", "denny"),
  ...contains(520, "Gas", "shell", "chevron", "exxon", "marathon", "speedway", "circle k", "7-eleven", "wawa", "quiktrip", "pilot travel", "casey's"),
  // "mobil" as a substring would swallow T-Mobile; word-bounded, it still
  // catches "MOBIL 7645" while "EXXONMOBIL" lands via the exxon rule.
  regex(520, "Gas", "\\bmobil\\b"),
  ...contains(520, "Subscriptions", "netflix", "spotify", "hulu", "disney plus", "disney+", "hbo max", "youtube premium", "youtubepremium", "apple.com/bill", "adobe", "dropbox", "icloud", "google one", "playstation network", "xbox game", "nintendo online", "patreon", "openai", "planet fitness", "la fitness", "equinox", "ymca"),
  ...contains(520, "Shopping", "ebay", "etsy", "best buy", "home depot", "lowes", "ikea", "wayfair", "macys", "nordstrom", "tj maxx", "tjmaxx", "marshalls", "ross stores", "old navy", "target"),
  ...contains(520, "Utilities", "comcast", "xfinity", "verizon", "at&t", "t-mobile", "tmobile", "spectrum", "cox comm", "pg&e", "con edison", "coned", "national grid", "duke energy"),
  ...contains(520, "Travel", "airbnb", "marriott", "hilton", "hyatt", "expedia", "booking.com", "vrbo", "delta air", "united air", "american airlines", "southwest air", "alaska air", "jetblue", "spirit air", "amtrak"),
  ...contains(520, "Health", "cvs", "walgreens", "rite aid", "kaiser", "quest diagnostics", "labcorp"),
  ...contains(520, "Entertainment", "amc theat", "regal cinemas", "cinemark", "ticketmaster", "stubhub", "steam purchase", "steampowered", "epic games"),

  // --- Generic-word heuristics: catch "Local Thai Kitchen" without knowing the brand
  regex(900, "Dining", "\\b(restaurant|cafe|coffee|espresso|pizza|pizzeria|sushi|thai|pho|ramen|taco|taqueria|burrito|grill|bistro|diner|bbq|barbecue|bakery|brewery|brewing|taphouse|pub|cantina|eatery|deli|steakhouse|wings?|donut|doughnut|ice cream|gelato|boba)\\b"),
  regex(910, "Groceries", "\\b(grocery|grocer|supermarket|supermercado|mercado|farmers market|food mart)\\b"),
  regex(920, "Gas", "\\b(gas station|fuel|gasoline)\\b"),
  regex(930, "Health", "\\b(pharmacy|dental|dentist|clinic|medical|hospital|optometr|chiropract|urgent care)\\b"),
  regex(940, "Transport", "\\b(parking|toll|transit|metro|taxi)\\b"),
  regex(950, "Entertainment", "\\b(cinema|theatre|theater|bowling|arcade)\\b"),
  regex(960, "Fees & Charges", "\\b(overdraft|atm fee|service charge|monthly fee|late fee|interest charge[ds]?)\\b"),
  regex(970, "Income", "\\b(payroll|salary|direct deposit)\\b", "DESCRIPTION"),
  // "market" alone is the loosest signal — keep it last so anything better wins
  regex(990, "Groceries", "\\bmarket\\b"),
];

export interface InstallResult {
  categoriesCreated: number;
  rulesCreated: number;
  rulesSkipped: number;
  transactionsRecategorized: number;
}

/**
 * Installs categories and pack rules idempotently (exact-match rules are
 * skipped), then retroactively applies ALL enabled rules to existing
 * non-MANUAL transactions and regenerates insights.
 */
export async function installRulePack(prisma: PrismaClient): Promise<InstallResult> {
  let categoriesCreated = 0;
  const categoryIds = new Map<string, string>();
  for (const name of PACK_CATEGORIES) {
    const isIncome = name === "Income";
    const existing = await prisma.category.findFirst({ where: { name } });
    if (existing !== null) {
      categoryIds.set(name, existing.id);
      if (isIncome && !existing.isIncome) {
        await prisma.category.update({ where: { id: existing.id }, data: { isIncome: true } });
      }
    } else {
      const created = await prisma.category.create({ data: { name, isIncome } });
      categoryIds.set(name, created.id);
      categoriesCreated++;
    }
  }

  let rulesCreated = 0;
  let rulesSkipped = 0;
  for (const rule of PACK_RULES) {
    const setCategoryId = categoryIds.get(rule.category) as string;
    const existing = await prisma.rule.findFirst({
      where: {
        matchField: rule.matchField,
        matchOperator: rule.matchOperator,
        matchValue: rule.matchValue,
      },
    });
    if (existing !== null) {
      rulesSkipped++;
      continue;
    }
    await prisma.rule.create({
      data: {
        priority: rule.priority,
        matchField: rule.matchField,
        matchOperator: rule.matchOperator,
        matchValue: rule.matchValue,
        setCategoryId,
        enabled: true,
      },
    });
    rulesCreated++;
  }

  const transactionsRecategorized = await reapplyRules(prisma);
  return { categoriesCreated, rulesCreated, rulesSkipped, transactionsRecategorized };
}

/**
 * Re-runs all enabled rules over every non-MANUAL transaction (used after
 * installing the pack or creating a rule) and regenerates insights when
 * anything changed. MANUAL stays sacred.
 */
export async function reapplyRules(prisma: PrismaClient): Promise<number> {
  const ruleRows = await prisma.rule.findMany({ where: { enabled: true } });
  if (ruleRows.length === 0) return 0;
  const txnRows = await prisma.transaction.findMany({ include: { account: true } });
  const ruleTxns: RuleTxn[] = txnRows.map((t) => ({
    id: t.id,
    amount: Number(t.amount),
    description: t.description,
    normalizedMerchant: t.normalizedMerchant,
    accountName: t.account.name,
    categorySource: t.categorySource,
  }));
  const applications = applyRules(
    ruleRows.map((r) => ({
      id: r.id,
      priority: r.priority,
      matchField: r.matchField,
      matchOperator: r.matchOperator,
      matchValue: r.matchValue,
      setCategoryId: r.setCategoryId,
      setFlow: r.setFlow,
      enabled: r.enabled,
    })),
    ruleTxns,
  );

  const byId = new Map(txnRows.map((t) => [t.id, t]));
  let changed = 0;
  for (const app of applications) {
    const txn = byId.get(app.txnId);
    if (txn === undefined) continue;
    const flowChange = app.flow !== null && app.flow !== txn.flow;
    if (txn.categoryId === app.categoryId && txn.categorySource === "RULE" && !flowChange) continue;
    await prisma.transaction.update({
      where: { id: app.txnId },
      data: {
        categoryId: app.categoryId,
        categorySource: "RULE",
        ...(app.flow === null ? {} : { flow: app.flow }),
      },
    });
    changed++;
  }
  if (changed > 0) {
    await generateInsights(prisma);
  }
  return changed;
}
