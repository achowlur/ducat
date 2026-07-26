import type { PrismaClient } from "../../generated/prisma/client";
import type { TransactionFlow } from "../../types/contracts";
import { generateInsights } from "../insights/engine";
import { applyRules, toRuleTxns } from "./rules";

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
  /** null for flow-only rules — a TRANSFER carries no category by convention. */
  category: (typeof PACK_CATEGORIES)[number] | null;
  setFlow?: "TRANSFER";
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

/**
 * Flow-only rules: mark a payee as TRANSFER so it's excluded from spending
 * analytics entirely (HARD RULE). Deliberately conservative — a false positive
 * here HIDES real spending, which is worse than mis-categorizing it, so this
 * band covers only movements that are value-neutral by definition. Anything
 * institution-specific (a brokerage's ACH descriptor, say) is left for the user
 * to mark via the grouped review, which writes a user-priority rule.
 */
const transferFlow = (
  priority: number,
  matchField: PackRule["matchField"],
  ...values: string[]
): PackRule[] =>
  values.map((matchValue) => ({
    priority,
    matchField,
    matchOperator: "CONTAINS" as const,
    matchValue,
    category: null,
    setFlow: "TRANSFER" as const,
  }));

export const PACK_RULES: PackRule[] = [
  // --- Value-neutral movements: cash changing form, never spending.
  // A dividend/interest reinvestment buys shares INSIDE one account, so there
  // is no second account for transfer-pair detection to match against — it can
  // only ever be caught by classification, not pairing.
  ...transferFlow(200, "DESCRIPTION", "reinvestment"),

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
    const setCategoryId = rule.category === null ? null : (categoryIds.get(rule.category) as string);
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
        setFlow: rule.setFlow ?? null,
        enabled: true,
      },
    });
    rulesCreated++;
  }

  const { changed: transactionsRecategorized } = await reapplyRules(prisma);
  return { categoriesCreated, rulesCreated, rulesSkipped, transactionsRecategorized };
}

/** A transaction's categorization exactly as it was before rules re-ran. */
export interface TxnRestore {
  id: string;
  categoryId: string | null;
  categorySource: "AGGREGATOR" | "RULE" | "MANUAL";
  flow: TransactionFlow;
}

/**
 * Everything one bulk decision changed, so it can be taken back: the rule as
 * it was (or absent), and each transaction's categorization before rules ran.
 * Lives here rather than beside the action because a "use server" module may
 * only export async functions.
 */
export interface GroupUndo {
  matchValue: string;
  matchField: "MERCHANT" | "DESCRIPTION";
  previousRule: { categoryId: string | null; flow: "TRANSFER" | null } | null;
  restore: TxnRestore[];
}

/**
 * Re-runs all enabled rules over every non-MANUAL transaction (used after
 * installing the pack or creating a rule) and regenerates insights when
 * anything changed. MANUAL stays sacred.
 *
 * Returns the prior state of every row it touched, because deleting a rule
 * does NOT reverse it: a rule only ever writes to rows it matches, so a row
 * whose rule is gone keeps the category it was given. Undo needs the before.
 */
export async function reapplyRules(
  prisma: PrismaClient,
): Promise<{ changed: number; restore: TxnRestore[] }> {
  const ruleRows = await prisma.rule.findMany({ where: { enabled: true } });
  if (ruleRows.length === 0) return { changed: 0, restore: [] };
  const txnRows = await prisma.transaction.findMany({ include: { account: true } });
  const applications = applyRules(ruleRows, toRuleTxns(txnRows));

  const byId = new Map(txnRows.map((t) => [t.id, t]));
  const restore: TxnRestore[] = [];
  for (const app of applications) {
    const txn = byId.get(app.txnId);
    if (txn === undefined) continue;
    const flowChange = app.flow !== null && app.flow !== txn.flow;
    if (txn.categoryId === app.categoryId && txn.categorySource === "RULE" && !flowChange) continue;
    restore.push({
      id: txn.id,
      categoryId: txn.categoryId,
      categorySource: txn.categorySource,
      flow: txn.flow,
    });
    await prisma.transaction.update({
      where: { id: app.txnId },
      data: {
        categoryId: app.categoryId,
        categorySource: "RULE",
        ...(app.flow === null ? {} : { flow: app.flow }),
      },
    });
  }
  if (restore.length > 0) {
    await generateInsights(prisma);
  }
  return { changed: restore.length, restore };
}
