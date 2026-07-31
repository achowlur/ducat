/**
 * Which rules match more than the merchant they were built from.
 *
 * The hazard is specific to CONTAINS, and it is invisible in normal use: a rule
 * that fails to match shows up as an uncategorized row on Overview, but a rule
 * that matches too much moves money silently. `createRuleFromMerchant` writes
 * CONTAINS over the whole normalized merchant, so a SHORT merchant becomes a
 * wildcard — "sage" claims "sagebrush", which is a bar, a salon and a cinema.
 * The rule pack already knows this and uses word-bounded REGEX for its short
 * brands ("ulta" inside "consultant", "rei" inside "reinvestment"); rules made
 * from the UI get no such protection.
 *
 * Matching here is the REAL matcher imported from sync/rules.ts, never a
 * re-implementation — audit-subscriptions.ts re-implements the recurring gates
 * and silently drifted from them, which is a mistake worth not repeating.
 *
 * Every distinct merchant a rule matches is classified:
 *   EXACT     merchant is exactly the rule value — always intended
 *   WORD      value sits at word boundaries ("belle mie" in "belle mie - maple st")
 *   MIDWORD   value runs into a longer word ("sage" in "sagebrush") — the hazard
 *
 * A rule with only EXACT/WORD matches is doing what it looks like it does. A
 * rule with any MIDWORD match is reported, loudest first by money at stake.
 *
 *   npm run rules:audit
 */
import { prisma } from '../src/lib/prisma';
import { applyRules, toRuleTxns, type RuleData } from '../src/lib/sync/rules';
import { databaseLabel } from './database-label';

type Kind = 'EXACT' | 'WORD' | 'MIDWORD';

/**
 * Where `value` sits inside `merchant`, by the same collapse the matcher uses.
 *
 * A word can only be cut where the VALUE'S OWN EDGE is alphanumeric. A rule
 * ending in a separator — "blizzard *", "heb #" — is already anchored at a
 * boundary by construction and cannot run into a longer word, so checking the
 * next character there reports a hazard that does not exist. That false
 * positive matters: an audit that cries wolf gets ignored, which is the lesson
 * the anomaly pass paid for.
 */
function classify(merchant: string, value: string): Kind {
  const m = merchant.toLowerCase().replace(/\s+/g, ' ').trim();
  const v = value.toLowerCase().replace(/\s+/g, ' ').trim();
  if (m === v) return 'EXACT';
  const at = m.indexOf(v);
  if (at < 0) return 'WORD'; // matched via DESCRIPTION, not the merchant
  // LETTERS, matching containsAtLetterBoundary exactly. Digit adjacency is a
  // store number and the matcher allows it deliberately, so reporting it here
  // would flag behaviour that is working as designed.
  const letter = (c: string) => /[a-z]/.test(c);
  const cutBefore = letter(v[0] ?? ' ') && at > 0 && letter(m[at - 1] ?? ' ');
  const cutAfter =
    letter(v[v.length - 1] ?? ' ') && at + v.length < m.length && letter(m[at + v.length] ?? ' ');
  return cutBefore || cutAfter ? 'MIDWORD' : 'WORD';
}

async function main(): Promise<void> {
  console.log(`\nDatabase: ${databaseLabel()}\n`);

  const [ruleRows, txnRows, categories] = await Promise.all([
    prisma.rule.findMany({ where: { enabled: true } }),
    prisma.transaction.findMany({ include: { account: true } }),
    prisma.category.findMany(),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const ruleById = new Map(ruleRows.map((r) => [r.id, r]));

  // The real matcher decides which rule actually WINS — priority order and the
  // P2P guard included — so this reports what the app does, not what a rule
  // could theoretically match on its own.
  const txns = toRuleTxns(txnRows);
  const byId = new Map(txnRows.map((t) => [t.id, t]));
  const applications = applyRules(ruleRows as unknown as RuleData[], txns);

  interface Hit { merchant: string; kind: Kind; count: number; total: number }
  const perRule = new Map<string, Map<string, Hit>>();

  for (const app of applications) {
    const rule = ruleById.get(app.ruleId);
    const txn = byId.get(app.txnId);
    if (rule === undefined || txn === undefined) continue;
    if (rule.matchOperator !== 'CONTAINS') continue; // EQUALS/REGEX carry no such hazard
    const kind = classify(txn.normalizedMerchant, rule.matchValue);
    const bucket = perRule.get(rule.id) ?? new Map<string, Hit>();
    const hit = bucket.get(txn.normalizedMerchant) ?? {
      merchant: txn.normalizedMerchant,
      kind,
      count: 0,
      total: 0,
    };
    hit.count += 1;
    hit.total += Math.abs(Number(txn.amount));
    bucket.set(txn.normalizedMerchant, hit);
    perRule.set(rule.id, bucket);
  }

  const suspect: { rule: (typeof ruleRows)[number]; hits: Hit[]; money: number }[] = [];
  let cleanRules = 0;

  for (const [ruleId, bucket] of perRule) {
    const rule = ruleById.get(ruleId);
    if (rule === undefined) continue;
    const hits = [...bucket.values()];
    if (hits.some((h) => h.kind === 'MIDWORD')) {
      const money = hits.filter((h) => h.kind === 'MIDWORD').reduce((s, h) => s + h.total, 0);
      suspect.push({ rule, hits, money });
    } else {
      cleanRules += 1;
    }
  }

  suspect.sort((a, b) => b.money - a.money);

  console.log(`CONTAINS rules that matched something: ${perRule.size}`);
  console.log(`  clean (exact or word-boundary only): ${cleanRules}`);
  console.log(`  matching mid-word:                   ${suspect.length}\n`);

  if (suspect.length === 0) {
    console.log('No rule is currently claiming a merchant by hiding inside a longer word.');
  }

  for (const s of suspect) {
    const band = s.rule.priority < 100 ? 'user' : 'pack';
    console.log(
      `p${s.rule.priority} (${band}) ${s.rule.matchField} CONTAINS "${s.rule.matchValue}" -> ${categoryName.get(s.rule.setCategoryId ?? '') ?? s.rule.setFlow ?? '?'}`,
    );
    for (const h of s.hits.sort((a, b) => b.total - a.total)) {
      const flag = h.kind === 'MIDWORD' ? '  <-- MID-WORD' : '';
      console.log(`     ${h.kind.padEnd(8)} ${h.count}x  $${h.total.toFixed(2).padStart(9)}  "${h.merchant}"${flag}`);
    }
    console.log('');
  }

  // Short CONTAINS values are the ones that can bite LATER even when today's
  // data happens to be clean, so they are listed whether or not they misfire
  // now. The pack's own short brands are regexes and never appear here.
  const short = ruleRows
    .filter((r) => r.matchOperator === 'CONTAINS' && r.matchField === 'MERCHANT' && r.matchValue.trim().length <= 5)
    .sort((a, b) => a.matchValue.length - b.matchValue.length);
  console.log(`Short MERCHANT CONTAINS values (<= 5 chars), risky whether or not they misfire today: ${short.length}`);
  for (const r of short) {
    console.log(
      `   p${r.priority} "${r.matchValue}" (${r.matchValue.trim().length} chars) -> ${categoryName.get(r.setCategoryId ?? '') ?? r.setFlow ?? '?'}`,
    );
  }
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
