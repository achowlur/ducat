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
 *   200-299 structural patterns — bank and brokerage bookkeeping descriptors
 *           rather than merchants, so they outrank every brand rule
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
  "Rent & Housing",
  "Taxes",
  "Cash & ATM",
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

/** As transferFlow, for descriptors that need two tokens to be safe. */
const transferRegex = (priority: number, matchValue: string): PackRule => ({
  priority,
  matchField: "DESCRIPTION",
  matchOperator: "REGEX",
  matchValue,
  category: null,
  setFlow: "TRANSFER",
});

export const PACK_RULES: PackRule[] = [
  // --- Value-neutral movements: cash changing form, never spending.
  // A dividend/interest reinvestment buys shares INSIDE one account, so there
  // is no second account for transfer-pair detection to match against — it can
  // only ever be caught by classification, not pairing.
  ...transferFlow(200, "DESCRIPTION", "reinvestment"),

  // Paying a credit card moves the same dollars between two of your own
  // accounts. Transfer-pair detection catches it only when BOTH sides are in
  // Ducat and the amounts are exact opposites within 4 days — an unlinked
  // card, a partial payment, or a slow posting each defeat that, so the
  // descriptors are classified here too. Every pattern needs a card token AND
  // a payment token: matching either alone would swallow ordinary card
  // purchases, and a false TRANSFER hides real spending outright.
  // Issuer side: "CHASE CREDIT CRD EPAY", "WF Credit Card   AUTO PAY".
  transferRegex(210, "\\bcredit\\s*(crd|card)\\b.*\\b(e-?pay|auto\\s?pay|payment|pymt)\\b"),
  // Card side: "Payment Thank You-Mobile", "ONLINE PAYMENT - THANK YOU".
  transferRegex(210, "\\bpayment\\s*[-,]?\\s*thank\\b"),
  // Wells Fargo bills a card payment as a plain transfer, naming the card
  // product. The product name is required: WF appends "CARD 1234" to every
  // debit-card purchase, so `card` alone here would hide half the statement.
  transferRegex(210, "\\bonline transfer\\b.*\\b(visa|mastercard|amex|credit)\\s+card\\b"),

  // ATM cash leaves the account with no merchant attached — a category of its
  // own is the honest answer, and where it went stays unknowable. The fee
  // pattern is ordered FIRST because "ATM WITHDRAWAL FEE" is a fee, not cash
  // (same specific-beats-general idiom as kroger fuel vs kroger below).
  regex(215, "Fees & Charges", "\\batm\\b.*\\bfee\\b", "DESCRIPTION"),
  regex(220, "Cash & ATM", "\\batm\\b.*\\b(withdrawal|wdl)\\b|\\bcash withdrawal\\b", "DESCRIPTION"),

  // Brokerage distributions arrive as cash and are income; the matching
  // "REINVESTMENT" row that spends it again is already a TRANSFER above, so
  // the pair nets to the dividend counted once. Both patterns name the event
  // rather than the word "dividend" alone, which is also a company name
  // ("DIVIDEND SOLAR") and a ticker's line item on a buy.
  regex(230, "Income", "\\b(dividends?\\s+(received|paid|earned)|cash dividends?)\\b", "DESCRIPTION"),
  regex(230, "Income", "\\b(long|short)[-\\s]term\\s+(cap|capital)\\s+gains?\\b", "DESCRIPTION"),

  // "USATAXPYMT" is the EFTPS descriptor every federal e-payment carries;
  // the second pattern covers the state agencies that collect the rest.
  regex(240, "Taxes", "\\busataxpymt\\b", "DESCRIPTION"),
  regex(240, "Taxes", "\\b(franchise tax bd|dept of revenue|department of revenue|dept of taxation)\\b", "DESCRIPTION"),

  // Rent portals. These were deliberately held back before, on the grounds
  // that a portal bills the operator's convenience FEE here ($7.88/month from
  // Zego) while billing the whole rent for someone else, and arithmetic cannot
  // tell which. That objection is about what the AMOUNT means, not about where
  // it belongs: a rent portal's charge is the cost of paying rent under either
  // reading, so Rent & Housing is correct both ways. What the objection was
  // really protecting against — a $7.88 "subscription" you cannot cancel — is
  // handled properly by NOT_SUBSCRIPTION_CATEGORIES in insights/recurring.ts.
  // Word-bounded, like every other short name here.
  regex(250, "Rent & Housing", "\\b(zego|paylease)\\b", "DESCRIPTION"),

  // --- Brands: order-sensitive pairs first (more specific = lower number)
  ...contains(500, "Dining", "uber eats", "ubereats", "doordash", "grubhub", "postmates"),
  ...contains(510, "Transport", "uber", "lyft"),
  ...contains(500, "Subscriptions", "amazon prime", "prime video", "audible"),
  ...contains(510, "Shopping", "amazon", "amzn"),
  ...contains(500, "Gas", "kroger fuel", "safeway fuel", "costco gas"),
  ...contains(510, "Groceries", "kroger", "safeway", "albertsons", "aldi", "trader joe", "whole foods", "wholefds", "wegmans", "publix", "food lion", "giant eagle", "sprouts", "winco", "costco", "sam's club", "wm supercenter", "walmart", "wal-mart", "instacart", "h-e-b", "heb #"),

  ...contains(520, "Dining", "mcdonald", "chipotle", "starbucks", "dunkin", "subway", "taco bell", "chick-fil-a", "wendy", "burger king", "domino", "pizza hut", "papa john", "panera", "five guys", "in-n-out", "shake shack", "kfc", "popeyes", "olive garden", "applebee", "chili's", "ihop", "denny"),
  // "exxonmobil" is listed BESIDE "exxon", not instead of it. A CONTAINS match
  // may no longer run into a longer word, so the prefix alone stopped reaching
  // the one-word spelling — and editing the shipped value would install a
  // second rule while leaving the original enabled everywhere the pack has
  // already run. Every pack value ending mid-word needs the same treatment.
  ...contains(520, "Gas", "shell", "chevron", "exxon", "exxonmobil", "marathon", "speedway", "circle k", "7-eleven", "wawa", "quiktrip", "pilot travel", "casey's"),
  // "mobil" as a substring would swallow T-Mobile; word-bounded, it still
  // catches "MOBIL 7645".
  regex(520, "Gas", "\\bmobil\\b"),
  ...contains(520, "Subscriptions", "netflix", "spotify", "hulu", "disney plus", "disney+", "hbo max", "youtube premium", "youtubepremium", "apple.com/bill", "adobe", "dropbox", "icloud", "google one", "playstation network", "xbox game", "nintendo online", "patreon", "openai", "planet fitness", "la fitness", "equinox", "ymca"),
  ...contains(520, "Shopping", "ebay", "etsy", "best buy", "home depot", "lowes", "ikea", "wayfair", "macys", "nordstrom", "tj maxx", "tjmaxx", "marshalls", "ross stores", "old navy", "target"),
  ...contains(520, "Utilities", "comcast", "xfinity", "verizon", "at&t", "t-mobile", "tmobile", "spectrum", "cox comm", "cox communications", "pg&e", "con edison", "coned", "national grid", "duke energy"),
  ...contains(520, "Travel", "airbnb", "marriott", "hilton", "hyatt", "expedia", "booking.com", "vrbo", "delta air", "delta airlines", "united air", "united airlines", "american airlines", "southwest air", "southwest airlines", "alaska air", "alaska airlines", "jetblue", "spirit air", "spirit airlines", "amtrak"),
  ...contains(520, "Health", "cvs", "walgreens", "rite aid", "kaiser", "quest diagnostics", "labcorp"),
  ...contains(520, "Entertainment", "amc theat", "amc theatre", "regal cinemas", "cinemark", "ticketmaster", "stubhub", "steam purchase", "steampowered", "epic games"),
  // "MACY'S 0000 ANYTOWN IL" is what the statement says, and
  // "macys" above never matched it — only macys.com, which writes it the
  // other way. Both spellings occur in one account's history.
  ...contains(520, "Shopping", "macy's"),

  // --- The long tail of chains, at 525 so the curated brands above still win
  // any tie. Everything here is a name a statement carries verbatim, drawn
  // from real statements first and then from the chains with the widest
  // footprint, because a fresh clone starts with none of this.
  ...contains(525, "Dining", "cold stone", "dairy queen", "jimmy john", "qdoba", "first watch", "cheesecake factory", "uncle julio", "menchie", "playa bowls", "toastique", "blaze pizza", "pieology", "sweetgreen", "just salad", "gong cha", "kung fu tea", "jersey mike", "potbelly", "wingstop", "raising cane", "whataburger", "culvers", "jack in the box", "del taco", "el pollo loco", "panda express", "pf chang", "red lobster", "outback steak", "texas roadhouse", "buffalo wild wings", "cracker barrel", "waffle house", "tim horton", "dutch bros", "krispy kreme", "baskin", "ben & jerry", "insomnia cookie", "crumbl", "halal guys", "little caesar", "sonic drive", "firehouse subs", "auntie anne", "cinnabon", "smoothie king", "zesta"),
  ...contains(525, "Groceries", "harris teeter", "hy-vee", "meijer", "stop & shop", "shoprite", "acme markets", "ralphs", "fred meyer", "king soopers", "jewel-osco", "lidl", "grocery outlet", "foodmart", "key food"),
  ...contains(525, "Shopping", "kohl", "jcpenney", "dillard", "famous footwear", "foot locker", "sephora", "bath & body", "victoria's secret", "american eagle", "hollister", "abercrombie", "urban outfitters", "uniqlo", "forever 21", "banana republic", "lululemon", "under armour", "dick's sporting", "academy sports", "bass pro", "cabela", "michaels stores", "hobby lobby", "joann", "party city", "barnes & noble", "gamestop", "b&h photo", "micro center", "newegg", "staples", "office depot", "petco", "petsmart", "tractor supply", "ace hardware", "menards", "harbor freight", "world market", "big lots", "dollar general", "dollar tree", "family dollar", "swarovski"),
  ...contains(525, "Transport", "trc tapgo", "e-zpass", "sunpass", "fastrak", "spothero", "parkmobile", "paybyphone", "citi bike", "zipcar", "sound transit", "clipper card", "ventra"),
  ...contains(525, "Travel", "hertz", "enterprise rent", "budget rent", "budget rental", "alamo rent", "alamo rental", "priceline", "hotels.com", "orbitz", "travelocity", "holiday inn", "hampton inn", "best western", "la quinta", "motel 6", "days inn", "wyndham", "sheraton", "frontier air", "frontier airlines", "allegiant air", "hawaiian air", "hawaiian airlines", "air canada", "lufthansa", "british airways", "greyhound", "flixbus", "megabus", "global entry", "chase travel"),
  ...contains(525, "Health", "duane reade", "walgreen", "minuteclinic", "zocdoc", "goodrx", "teladoc", "lenscrafters", "warby parker", "pearle vision", "aspen dental", "delta dental", "blue cross", "blue shield"),
  // "blizzard *" rather than the bare word: a Dairy Queen Blizzard is dinner.
  ...contains(525, "Entertainment", "silverspot", "alamo drafthouse", "fandango", "atom tickets", "dave & buster", "topgolf", "chuck e cheese", "sky zone", "bowlero", "six flags", "cedar point", "universal studios", "walt disney world", "disneyland", "seaworld", "busch gardens", "blizzard *", "riot games", "roblox", "nintendo", "eventbrite", "seatgeek", "vivid seats"),
  ...contains(525, "Subscriptions", "coursera", "udemy", "masterclass", "duolingo", "notion.so", "figma", "grammarly", "1password", "nordvpn", "github", "nytimes", "new york times", "wall street journal", "washington post", "the athletic", "substack", "peloton", "strava", "headspace", "sirius", "paramount+", "peacock", "starz", "crunchyroll", "orangetheory", "anytime fitness", "24 hour fitness", "blink fitness", "crunch fitness"),
  // SoCalGas is a gas UTILITY, not a filling station — and it is why the
  // fuel heuristic at 920 needs the word "gas" standing on its own.
  ...contains(525, "Utilities", "socalgas", "dominion energy", "xcel energy", "ameren", "entergy", "florida power", "georgia power", "dte energy", "consumers energy", "peoples gas", "washington gas", "eversource", "pseg", "puget sound energy", "austin energy", "reliant energy", "nv energy", "southern california edison", "ladwp", "centurylink", "frontier communications", "starlink", "mint mobile", "cricket wireless", "boost mobile", "us cellular", "straight talk"),
  // Names short enough, or common enough as a fragment, that a substring
  // match would swallow an unrelated merchant: "ulta" hides inside
  // "consultant", "avis" inside "Davis", "one medical" inside "Stone
  // Medical", "westin" inside "Westinghouse", "canva" inside "canvas".
  regex(525, "Dining", "\\b(arby|nando)\\b"),
  regex(525, "Groceries", "\\b(vons|iga)\\b"),
  regex(525, "Shopping", "\\b(ulta|zara|h&m|gap|nike|adidas|rei|dsw|chewy|temu|shein)\\b"),
  regex(525, "Transport", "\\b(trc|tapgo|bart|metrocard)\\b"),
  regex(525, "Travel", "\\b(avis|turo|westin)\\b"),
  regex(525, "Health", "\\bone medical\\b"),
  regex(525, "Subscriptions", "\\bcanva\\b"),

  // --- Generic-word heuristics: catch "Local Thai Kitchen" without knowing the brand
  regex(900, "Dining", "\\b(restaurant|cafe|coffee|espresso|pizza|pizzeria|sushi|thai|pho|ramen|taco|taqueria|burrito|grill|bistro|diner|bbq|barbecue|bakery|brewery|brewing|taphouse|pub|cantina|eatery|deli|steakhouse|wings?|donut|doughnut|ice cream|gelato|boba)\\b"),
  // A second pass rather than an edit to the line above: installRulePack
  // matches existing rules by their matchValue, so changing one leaves the
  // old row behind in every database that already ran the pack.
  regex(901, "Dining", "\\b(creamery|frozen yogurt|churro|empanada|arepa|shawarma|falafel|kebab|dumpling|noodles?|udon|poke|acai|smoothie|patisserie|creperie|trattoria|osteria|izakaya|hibachi|teriyaki|dim sum|halal|cheesecake|juice bar|food truck)\\b"),
  regex(910, "Groceries", "\\b(grocery|grocer|supermarket|supermercado|mercado|farmers market|food mart)\\b"),
  regex(911, "Groceries", "\\b(food center|food bazaar|produce market|fish market|butcher)\\b"),
  regex(920, "Gas", "\\b(gas station|fuel|gasoline)\\b"),
  regex(930, "Health", "\\b(pharmacy|dental|dentist|clinic|medical|hospital|optometr|chiropract|urgent care)\\b"),
  regex(940, "Transport", "\\b(parking|toll|transit|metro|taxi)\\b"),
  regex(950, "Entertainment", "\\b(cinema|theatre|theater|bowling|arcade)\\b"),
  regex(951, "Entertainment", "\\b(museum|aquarium|zoo|mini golf|escape room|karaoke|planetarium|botanic)\\b"),
  regex(960, "Fees & Charges", "\\b(overdraft|atm fee|service charge|monthly fee|late fee|interest charge[ds]?)\\b"),
  regex(970, "Income", "\\b(payroll|salary|direct deposit)\\b", "DESCRIPTION"),
  // Rent reaches a landlord's own name far more often than a recognizable
  // brand, so this is all the pack can honestly claim; the rest is what the
  // grouped review is for. "realty" is deliberately absent — it is a REIT
  // name too, and "YOU BOUGHT REALTY INCOME CORP" is not a housing expense.
  regex(980, "Rent & Housing", "\\b(apartments?|property management|property mgmt|leasing office|homeowners assoc)\\b"),
  // "market" alone is the loosest signal — keep it last so anything better wins
  regex(990, "Groceries", "\\bmarket\\b"),

  // The payment rail, which normalizeMerchant strips off the merchant name
  // but the raw description keeps. Weaker evidence than any word in the name,
  // so it speaks last: Toast, Slice and DoorDash sell restaurant software and
  // nothing else, which makes the rail itself the category.
  //
  // Square, Paytronix, SpotOn, GoDaddy Payments, Fivestars and UEP are
  // deliberately absent. Their prefixes still come off the merchant name —
  // that part is pure gain — but they bill salons, retail and corner shops
  // too, and "probably food" is not good enough to spend someone's money on.
  regex(995, "Dining", "\\btst\\s*\\*", "DESCRIPTION"),
  regex(995, "Dining", "\\bslice\\s*\\*", "DESCRIPTION"),
  regex(995, "Dining", "\\bdd\\s*\\*", "DESCRIPTION"),
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
  // Existence is decided in memory against one read of each table. Asking the
  // database ~190 separate "does this already exist?" questions is the whole
  // cost of this command.
  const existingCategories = await prisma.category.findMany({ select: { id: true, name: true, isIncome: true } });
  const categoryIds = new Map(existingCategories.map((c) => [c.name, c.id]));

  const missingCategories = PACK_CATEGORIES.filter((name) => !categoryIds.has(name));
  if (missingCategories.length > 0) {
    await prisma.category.createMany({
      data: missingCategories.map((name) => ({ name, isIncome: name === "Income" })),
    });
    const created = await prisma.category.findMany({
      where: { name: { in: [...missingCategories] } },
      select: { id: true, name: true },
    });
    for (const c of created) categoryIds.set(c.name, c.id);
  }
  const categoriesCreated = missingCategories.length;

  // "Income" may pre-date the pack as a spending category.
  const incomeRow = existingCategories.find((c) => c.name === "Income");
  if (incomeRow !== undefined && !incomeRow.isIncome) {
    await prisma.category.update({ where: { id: incomeRow.id }, data: { isIncome: true } });
  }

  const existingRules = await prisma.rule.findMany({
    select: { matchField: true, matchOperator: true, matchValue: true },
  });
  const ruleKey = (r: { matchField: string; matchOperator: string; matchValue: string }) =>
    `${r.matchField}|${r.matchOperator}|${r.matchValue}`;
  const known = new Set(existingRules.map(ruleKey));

  const toCreate = PACK_RULES.filter((r) => !known.has(ruleKey(r)));
  if (toCreate.length > 0) {
    await prisma.rule.createMany({
      data: toCreate.map((rule) => ({
        priority: rule.priority,
        matchField: rule.matchField,
        matchOperator: rule.matchOperator,
        matchValue: rule.matchValue,
        setCategoryId: rule.category === null ? null : (categoryIds.get(rule.category) as string),
        setFlow: rule.setFlow ?? null,
        enabled: true,
      })),
    });
  }
  const rulesCreated = toCreate.length;
  const rulesSkipped = PACK_RULES.length - rulesCreated;

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
  // Rows headed for the same category and flow are written together: one
  // statement per distinct target (a dozen or so) instead of one per row.
  const batches = new Map<string, { categoryId: string | null; flow: TransactionFlow | null; ids: string[] }>();
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
    const key = `${app.categoryId ?? ""}|${app.flow ?? ""}`;
    const batch = batches.get(key) ?? { categoryId: app.categoryId, flow: app.flow, ids: [] };
    batch.ids.push(app.txnId);
    batches.set(key, batch);
  }
  for (const batch of batches.values()) {
    await prisma.transaction.updateMany({
      where: { id: { in: batch.ids } },
      data: {
        categoryId: batch.categoryId,
        categorySource: "RULE",
        ...(batch.flow === null ? {} : { flow: batch.flow }),
      },
    });
  }
  if (restore.length > 0) {
    await generateInsights(prisma);
  }
  return { changed: restore.length, restore };
}
