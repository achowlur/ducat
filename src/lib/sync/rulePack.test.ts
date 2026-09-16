import { describe, expect, it } from "vitest";
import { normalizeMerchant } from "../connectors/normalize";
import { applyRules, type RuleData, type RuleTxn } from "./rules";
import { P2P_PATTERN, PACK_CATEGORIES, PACK_RULES } from "./rulePack";

/**
 * The merchant corpus: realistic, messy bank strings run through the SAME
 * pipeline real imports use (normalizeMerchant → applyRules over the pack).
 * Expected results are deliberate decisions, including the deliberate
 * "null" cases — a wrong bucket is worse than no bucket.
 */

// Pack rules as pure RuleData, category NAME standing in for the id.
const rules: RuleData[] = PACK_RULES.map((r, i) => ({
  id: `pack-${i}`,
  priority: r.priority,
  matchField: r.matchField,
  matchOperator: r.matchOperator,
  matchValue: r.matchValue,
  setCategoryId: r.category,
  setFlow: r.setFlow ?? null,
  enabled: true,
}));

/**
 * Category name, "TRANSFER" for a flow-only rule, or null when nothing
 * matched. Flow has to come back distinguishable from null: a rule that
 * marks a payee TRANSFER carries no category, so collapsing the two would
 * make "excluded from spending" and "no idea" look identical.
 */
function categorize(rawMerchant: string, description = rawMerchant, amount = -25): string | null {
  const txn: RuleTxn = {
    id: "t1",
    amount,
    description,
    normalizedMerchant: normalizeMerchant(rawMerchant),
    accountName: "Checking",
    categorySource: "AGGREGATOR",
  };
  const result = applyRules(rules, [txn]);
  if (result.length === 0) return null;
  return result[0].flow ?? result[0].categoryId;
}

describe("starter pack: merchant corpus", () => {
  const CORPUS: [raw: string, expected: string | null][] = [
    // --- Dining: brands, prefixes, delivery, generic words
    ["CHIPOTLE 2337", "Dining"],
    ["MCDONALD'S F13729", "Dining"],
    ["STARBUCKS STORE 05798", "Dining"],
    ["DUNKIN #349762", "Dining"],
    ["CHICK-FIL-A #01822", "Dining"],
    ["TST* JOES PIZZA 412 LAKE CITY", "Dining"], // Toast prefix + generic word
    ["SQ *BLUE BOTTLE COFFEE OAKLAND", "Dining"], // "coffee", not the Square rail
    ["LOCAL THAI KITCHEN", "Dining"], // no brand — the word "thai" carries it
    ["DOORDASH*CHIPOTLE", "Dining"], // delivery prefix wins, same bucket anyway
    ["UBER EATS PENDING SF", "Dining"], // must NOT fall through to Uber=Transport

    // --- Groceries: brands without the word "grocery" in them
    ["KROGER #532", "Groceries"],
    ["SAFEWAY STORE 1442", "Groceries"],
    ["TRADER JOE'S #058", "Groceries"],
    ["WHOLEFDS MKT 10259", "Groceries"], // Whole Foods' actual statement string
    ["WM SUPERCENTER #1234", "Groceries"],
    ["WAL-MART #2153", "Groceries"],
    ["COSTCO WHSE #0482", "Groceries"],
    ["ITHACA FARMERS MARKET", "Groceries"], // generic-word heuristic

    // --- Ordering guarantees: specific beats general
    ["KROGER FUEL #532", "Gas"], // fuel center, not the grocery aisle
    ["AMAZON PRIME*2H4XY89Z2", "Subscriptions"], // beats Amazon=Shopping
    ["AMZN MKTP US*2X4AB7QW3", "Shopping"],
    ["UBER TRIP HELP.UBER.COM", "Transport"],

    // --- Gas
    ["SHELL OIL 57444199283", "Gas"],
    ["EXXONMOBIL 97534514", "Gas"],
    ["7-ELEVEN 32441", "Gas"],

    // --- Subscriptions / utilities / travel / health / entertainment
    ["NETFLIX.COM", "Subscriptions"],
    ["SPOTIFY USA", "Subscriptions"],
    ["GOOGLE *YOUTUBEPREMIUM", "Subscriptions"],
    ["PLANET FITNESS CLUB FEES", "Subscriptions"], // brand beats the "fees" heuristic
    ["COMCAST CABLE COMM", "Utilities"],
    ["T-MOBILE AUTO PAY", "Utilities"],
    ["PG&E WEB ONLINE PAY", "Utilities"],
    // The utility, not a filling station. It only works because the fuel
    // heuristic needs "gas" standing alone and "socalgas" is one token.
    ["SOCALGAS BILL PAYMENT", "Utilities"],
    ["DELTA AIR 00623411229876", "Travel"],
    ["MARRIOTT DOWNTOWN SEATTLE", "Travel"],
    ["AIRBNB * HMXYZ123", "Travel"],
    ["CVS/PHARMACY #04291", "Health"],
    ["ST MARYS HOSPITAL PARKG", "Health"],
    ["CITY OF AUSTIN PARKING METERS", "Transport"],
    ["STEAM PURCHASE 425-952-2985 WA", "Entertainment"],
    ["IKEA RENTON", "Shopping"],
    ["TARGET T-2412", "Shopping"],
    ["OVERDRAFT ITEM FEE", "Fees & Charges"],

    // --- Deliberate nulls: guessing here would corrupt analytics
    ["ZELLE PAYMENT TO SMITH JOHN 84321", null], // rent? reimbursement? unknowable
    ["VENMO PAYMENT 1023996", null],
    ["CASH APP*JANE DOE", null],
    ["PAYPAL *STEAM GAMES", null], // PayPal-routed — payee string unreliable
    ["BOBS HARDWARE", null], // honest unknown beats a wrong guess
    ["USPS PO 4455900129", null],
  ];

  it.each(CORPUS)("%s → %s", (raw, expected) => {
    expect(categorize(raw)).toBe(expected);
  });

  it("categorizes payroll from the description field (merchant carries no signal)", () => {
    expect(categorize("acme corp", "ACME CORP PAYROLL DES:1029447")).toBe("Income");
  });

  it("reads the rail only for processors that sell nothing but restaurant software", () => {
    // No word in either name is a food word — the prefix is the only evidence,
    // and "joespizza" is one token, so \bpizza\b cannot reach inside it.
    expect(categorize("TST*RIVERSIDE COMMONS")).toBe("Dining");
    expect(categorize("SLICE*JOESPIZZA")).toBe("Dining");
    expect(categorize("DD *BLUEBARN")).toBe("Dining");
    // Square, Fivestars and the rest bill salons and retail too: the prefix
    // still comes off the merchant name, but it buys no category.
    expect(categorize("SQ *HAIR STUDIO 9")).toBeNull();
    expect(categorize("FIV*TEAHOUSE")).toBeNull();
    expect(categorize("GDP*CORNER PIE LLC")).toBeNull();
  });

  it("never touches MANUAL transactions", () => {
    const txn: RuleTxn = {
      id: "t1",
      amount: -15.99,
      description: "NETFLIX.COM",
      normalizedMerchant: "netflix",
      accountName: "Checking",
      categorySource: "MANUAL",
    };
    expect(applyRules(rules, [txn])).toEqual([]);
  });
});

describe("starter pack: shape", () => {
  // installRulePack dedupes against what a database already has, not against
  // the pack itself, so a value listed twice here installs twice — invisible
  // in the UI except as a duplicate row the user has to read past.
  it("lists no rule twice", () => {
    const counts = new Map<string, number>();
    for (const r of PACK_RULES) {
      const key = `${r.matchField}|${r.matchOperator}|${r.matchValue}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });

  it("points every categorizing rule at a category the pack installs", () => {
    const known = new Set<string>(PACK_CATEGORIES);
    for (const r of PACK_RULES) {
      if (r.category !== null) expect(known.has(r.category)).toBe(true);
      else expect(r.setFlow).toBe("TRANSFER");
    }
  });
});

describe("starter pack: the long tail of chains", () => {
  const CHAINS: [raw: string, expected: string | null][] = [
    ["MACY'S 0000 ANYTOWN IL", "Shopping"], // the apostrophe form
    ["MACYS .COM 0000000000 OH", "Shopping"], // and the form macys.com uses
    ["QDOBA 2002", "Dining"],
    ["JIMMY JOHNS - 2001", "Dining"],
    ["COLD STONE CREAMERY #22", "Dining"],
    ["FIRST WATCH - 0404", "Dining"],
    ["DAIRY QUEEN BLIZZARD 4412", "Dining"], // dessert, not the game studio
    ["BLIZZARD *US0000000000", "Entertainment"],
    ["FOODMART #12", "Groceries"],
    ["WORLD MARKET 4412", "Shopping"], // beats the "market" catch-all
    ["TRC TAPGO LAKE CITY IL", "Transport"],
    ["SILVERSPOT CINEMA 12", "Entertainment"],
    ["DELTA DENTAL OF NEW JERSEY", "Health"], // not Delta Air Lines
    ["ALAMO RENT A CAR PHOENIX", "Travel"],
    ["TST* ALAMO DRAFTHOUSE", "Entertainment"], // beats the Toast rail
    ["GAP #1291", "Shopping"],
    ["H&M 0912", "Shopping"],
    ["REI CO-OP SEATTLE", "Shopping"],
    ["SOUTHERN CALIFORNIA EDISON", "Utilities"],
    ["COURSERA.ORG", "Subscriptions"],

    // Fragments that must NOT be read as the brand they hide inside.
    ["CONSULTANT SERVICES LLC", null], // ulta
    ["DAVIS HARDWARE SUPPLY", null], // avis
    ["STONE MEDICAL BILLING", "Health"], // "medical", not One Medical
    ["WESTINGHOUSE SERVICE CO", null], // westin
    ["CANVAS PRINTS DIRECT", null], // canva
    ["CULVER CITY DRY CLEANER", null], // culvers
  ];

  it.each(CHAINS)("%s → %s", (raw, expected) => {
    expect(categorize(raw)).toBe(expected);
  });
});

/**
 * Bank and brokerage bookkeeping, which arrives as a descriptor rather than a
 * merchant. Strings are the real shapes seen on Wells Fargo, Chase and
 * Fidelity statements, with names and numbers replaced.
 */
describe("starter pack: structural descriptors", () => {
  const DESCRIPTORS: [description: string, expected: string | null][] = [
    // --- Credit-card payments: value-neutral on both sides
    ["CHASE CREDIT CRD EPAY       260321 0000000000      JANE DOE", "TRANSFER"],
    ["CHASE CREDIT CRD AUTOPAY    XXXXXX XXXXXXXXXXX1234 JANE DOE", "TRANSFER"],
    ["WF Credit Card   AUTO PAY   251228 00000000000000  DOE,JANE", "TRANSFER"],
    ["Payment Thank You-Mobile", "TRANSFER"],
    ["ONLINE PAYMENT THANK YOU", "TRANSFER"],
    ["AUTOMATIC PAYMENT - THANK YOU", "TRANSFER"],
    ["ONLINE TRANSFER REF #IB0AAAAAAA TO WELLS FARGO CASH REWARDS VISA CARD XXXXXXXXXXXX1234 ON 07/13/26", "TRANSFER"],

    // --- Cash: its own category, because where it went is unknowable
    ["ATM WITHDRAWAL                 AUTHORIZED ON   04/29 100 MAIN ST STE 1         ANYTOWN       IL  0000000           ATM ID 0001A    CARD 1234", "Cash & ATM"],
    ["NON-WF ATM WITHDRAWAL FEE", "Fees & Charges"], // a fee, not cash
    ["CASH WITHDRAWAL 00423 MAIN ST", "Cash & ATM"],

    // --- Brokerage: distributions are income, reinvesting them is not
    ["DIVIDEND RECEIVED FIDELITY 500 INDEX FUND (FZZAX) (Cash)", "Income"],
    ["LONG-TERM CAP GAIN FIDELITY CONTRAFUND (FZZBX) (Cash)", "Income"],
    ["SHORT-TERM CAP GAIN FIDELITY LARGE CAP STOCK (FZZCX) (Cash)", "Income"],
    ["REINVESTMENT FIDELITY 500 INDEX FUND (FZZAX) (Cash)", "TRANSFER"],
    // The automatic sweep into the core position, with and without the
    // "MORNING TRADE" marker the feed sometimes adds.
    ["PURCHASE INTO CORE ACCOUNT FIDELITY GOVERNMENT CASH RESERVES (FDRXX) (Cash)", "TRANSFER"],
    ["PURCHASE INTO CORE ACCOUNT MORNING TRADE FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)", "TRANSFER"],

    // --- Taxes
    ["IRS              USATAXPYMT 041226 000000000000000 JANE H DOE", "Taxes"],

    // --- Rent: a landlord's own name is all most statements carry
    ["SUNRISE APARTMENTS LLC", "Rent & Housing"],
    ["KEYSTONE PROPERTY MANAGEMENT", "Rent & Housing"],

    // --- Near misses that must NOT match
    // Wells Fargo appends "CARD nnnn" to every debit-card purchase, so the
    // card-payment patterns must need a card PRODUCT, not the word "card".
    ["PURCHASE AUTHORIZED ON 07/12 BOBS HARDWARE FAIRVIEW IL CARD 1234", null],
    ["YOU BOUGHT REALTY INCOME CORP (O) (Cash)", null], // a REIT, not housing
    ["DIVIDEND SOLAR FINANCE PAYMENT", null], // a lender named Dividend
  ];

  it.each(DESCRIPTORS)("%s → %s", (description, expected) => {
    expect(categorize(description)).toBe(expected);
  });

  // The feed signs the sweep POSITIVE (cash arriving in the core position)
  // where the reinvestment line is negative; the rule reads the words, so
  // either sign ends TRANSFER.
  it("marks the core-position sweep TRANSFER whichever way it is signed", () => {
    const sweep = "PURCHASE INTO CORE ACCOUNT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash)";
    expect(categorize("fidelity", sweep, 25)).toBe("TRANSFER");
    expect(categorize("fidelity", sweep, -25)).toBe("TRANSFER");
  });

  it("does not let a card payment hide an ordinary purchase on the same statement", () => {
    // Both rows carry "CARD 1234"; only one is a payment.
    expect(categorize("PURCHASE AUTHORIZED ON 07/12 TRADER JOES 058 FAIRVIEW IL CARD 1234")).toBe("Groceries");
  });
});

describe("P2P review flag", () => {
  it("matches P2P payment processors", () => {
    for (const s of [
      "zelle payment to smith john",
      "VENMO PAYMENT",
      "cash app*jane doe",
      "cashapp transfer",
      "PAYPAL *STEAM GAMES",
      "wire transfer outgoing",
    ]) {
      expect(P2P_PATTERN.test(s)).toBe(true);
    }
  });

  it("does not flag ordinary merchants", () => {
    for (const s of ["netflix.com", "kroger #532", "shell oil", "papa john's"]) {
      expect(P2P_PATTERN.test(s)).toBe(false);
    }
  });

  it("no pack rule ever categorizes a P2P payment", () => {
    expect(categorize("ZELLE PAYMENT TO LANDLORD LLC")).toBeNull();
    expect(categorize("VENMO *GROCERY MONEY")).toBeNull(); // even with a tempting word...
  });
});

/**
 * Pack values that end mid-word, and the fuller spellings they must still
 * reach. CONTAINS may no longer run a match into a longer word, so a truncated
 * prefix like "exxon" or "amc theat" stops reaching "EXXONMOBIL" and "AMC
 * THEATRES" on its own — the full form has to be listed beside it.
 *
 * These are pinned separately from the main corpus because they are a CLASS,
 * not a handful of brands: anyone adding a pack value that stops mid-word owes
 * an entry here, and the failure it guards against is silent (the charge simply
 * goes uncategorized) rather than loud.
 */
describe("starter pack: values that end mid-word keep their full spellings", () => {
  const BOTH_SPELLINGS: [raw: string, expected: string][] = [
    ["EXXON 4471", "Gas"],
    ["EXXONMOBIL 97534514", "Gas"],
    ["AMC THEAT 0382", "Entertainment"],
    ["AMC THEATRES 034", "Entertainment"],
    ["DELTA AIR LINES 0062", "Travel"],
    ["DELTA AIRLINES 0062", "Travel"],
    ["UNITED AIRLINES 016", "Travel"],
    ["ALASKA AIRLINES 027", "Travel"],
    ["SPIRIT AIRLINES 487", "Travel"],
    ["COX COMM 8841", "Utilities"],
    ["COX COMMUNICATIONS", "Utilities"],
    ["ALAMO RENT A CAR", "Travel"],
    ["ALAMO RENTAL 8823", "Travel"],
  ];

  it.each(BOTH_SPELLINGS)("%s → %s", (raw, expected) => {
    expect(categorize(raw)).toBe(expected);
  });

  // The plural case the matcher handles on its own, so no pack entry is
  // needed — one trailing letter is an inflection, not a different word.
  const INFLECTED: [raw: string, expected: string][] = [
    ["TRADER JOES 058", "Groceries"],
    ["JIMMY JOHNS - 2001", "Dining"],
    ["PAPA JOHNS 04412", "Dining"],
    ["DOMINOS 8842", "Dining"],
  ];

  it.each(INFLECTED)("%s → %s without a pack entry of its own", (raw, expected) => {
    expect(categorize(raw)).toBe(expected);
  });
});
