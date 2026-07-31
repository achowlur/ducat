/**
 * What changes if CONTAINS stops cutting into words.
 *
 * Read-only. Runs the SAME matcher twice — once with `SUBSTRING`, the older
 * and wider behaviour, once with `LETTER_BOUNDARY`, which now ships — and
 * reports every disagreement. Nothing is written.
 *
 * Kept after the change landed, because it is the instrument for the next one:
 * a new rule, a widened value or a normalization change can all reintroduce an
 * over-match, and this is what measures it. Read the direction accordingly —
 * PASS 1's "was" column is the retired behaviour, not the current one.
 *
 * The honest difficulty is that real transactions are the wrong instrument for
 * most of this question. A collision only shows up once you happen to shop at a
 * merchant whose name embeds one of your rule values, so a clean run over any
 * number of real rows proves the hazard has not FIRED yet, never that it is
 * absent. Volume does not help either: the tenth thousand transaction is drawn
 * from the same few hundred merchants as the first thousand.
 *
 * So the simulation asks three separate questions, and only the first one is
 * about the data you happen to have:
 *
 *   PASS 1  REAL — every stored transaction, both matchers. What changes today.
 *   PASS 2  VARIANTS — every real merchant, decorated the way banks decorate
 *           them (store numbers, branch codes, reference suffixes, processor
 *           prefixes, truncation). This is the REGRESSION test: the new matcher
 *           must keep claiming these, and anything it drops is a real cost.
 *   PASS 3  COLLISIONS — every rule value embedded inside a longer word, which
 *           is the hazard by definition. Exhaustive over the rule set rather
 *           than sampled from history, so it measures the whole exposure and
 *           not the part that has already bitten.
 *
 * Pass 3 needs no corpus at all: for any value V the collision set is generated
 * from V itself. Pass 2 is where more real data genuinely helps, because it is
 * the only pass whose realism depends on having seen how merchants actually
 * vary — a CSV backfill widens it, more of the same months does not.
 *
 *   npm run rules:simulate
 */
import { prisma } from '../src/lib/prisma';
import { applyRules, toRuleTxns, type RuleData, type RuleTxn } from '../src/lib/sync/rules';
import { databaseLabel } from './database-label';

const MONEY = (n: number): string => `$${n.toFixed(2)}`;

/** Bank decorations observed in this dataset and recorded in CLAUDE.md. */
function variantsOf(merchant: string): { label: string; text: string }[] {
  return [
    { label: 'store number prefix', text: `895${merchant}` },
    { label: 'store number suffix', text: `${merchant} 0472` },
    { label: 'branch code', text: `${merchant} #1234` },
    { label: 'reference suffix', text: `${merchant} us1000000001` },
    { label: 'processor prefix', text: `sq *${merchant}` },
    { label: 'location suffix', text: `${merchant} fairview il` },
    // The bank truncating a long name is the one decoration that removes
    // characters, and the only place the new matcher can legitimately lose.
    { label: 'truncated to 24', text: merchant.slice(0, 24) },
  ];
}

/** A value embedded so it cuts a word — the hazard, constructed from the value. */
function collisionsOf(value: string): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  if (/[a-z]$/.test(value)) out.push({ label: 'letter after', text: `${value}ing` });
  if (/^[a-z]/.test(value)) out.push({ label: 'letter before', text: `gr${value}` });
  if (/^[a-z]/.test(value) && /[a-z]$/.test(value)) {
    out.push({ label: 'both sides', text: `un${value}ed` });
  }
  return out;
}

function probe(rules: RuleData[], text: string): RuleTxn {
  void rules;
  return {
    id: text,
    amount: -10,
    description: text,
    normalizedMerchant: text,
    accountName: 'probe',
    categorySource: 'AGGREGATOR',
  };
}

async function main(): Promise<void> {
  console.log(`\nDatabase: ${databaseLabel()}`);
  console.log('Read-only simulation. Nothing is written.\n');

  const [ruleRows, txnRows, categories] = await Promise.all([
    prisma.rule.findMany({ where: { enabled: true } }),
    prisma.transaction.findMany({ include: { account: true } }),
    prisma.category.findMany(),
  ]);
  const rules = ruleRows as unknown as RuleData[];
  const catName = (id: string | null): string => categories.find((c) => c.id === id)?.name ?? 'none';
  const ruleById = new Map(ruleRows.map((r) => [r.id, r]));
  const describeRule = (id: string | undefined): string => {
    if (id === undefined) return 'no rule';
    const r = ruleById.get(id);
    return r === undefined ? 'no rule' : `p${r.priority} ${r.matchField} ${r.matchOperator} "${r.matchValue}"`;
  };

  // ---- PASS 1: real transactions -------------------------------------------
  const txns = toRuleTxns(txnRows);
  const before = new Map(applyRules(rules, txns, 'SUBSTRING').map((a) => [a.txnId, a]));
  const after = new Map(applyRules(rules, txns, 'LETTER_BOUNDARY').map((a) => [a.txnId, a]));
  const txnById = new Map(txnRows.map((t) => [t.id, t]));

  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((id) => {
    const b = before.get(id);
    const a = after.get(id);
    return (b?.categoryId ?? null) !== (a?.categoryId ?? null) || (b?.ruleId ?? null) !== (a?.ruleId ?? null);
  });

  console.log(`PASS 1 — REAL: ${txns.length} transactions, ${rules.length} enabled rules`);
  console.log(`  rows whose winning rule or category changes: ${changed.length}\n`);
  for (const id of changed) {
    const t = txnById.get(id);
    if (t === undefined) continue;
    const b = before.get(id);
    const a = after.get(id);
    const moved = (b?.categoryId ?? null) !== (a?.categoryId ?? null);
    console.log(`  ${t.date.toISOString().slice(0, 10)} ${MONEY(Math.abs(Number(t.amount)))}  "${t.normalizedMerchant}"`);
    console.log(`     was: ${catName(b?.categoryId ?? null)}  via ${describeRule(b?.ruleId)}`);
    console.log(`     now: ${catName(a?.categoryId ?? null)}  via ${describeRule(a?.ruleId)}${moved ? '' : '   (same category, different rule)'}`);
  }

  // ---- PASS 2: bank decorations on real merchants ---------------------------
  const merchants = [...new Set(txnRows.map((t) => t.normalizedMerchant))].filter((m) => m.trim() !== '');
  let variantProbes = 0;
  const lost: { merchant: string; label: string; text: string; rule: string; category: string }[] = [];

  for (const merchant of merchants) {
    for (const v of variantsOf(merchant)) {
      if (v.text === merchant) continue;
      variantProbes += 1;
      const p = [probe(rules, v.text)];
      const b = applyRules(rules, p, 'SUBSTRING')[0];
      const a = applyRules(rules, p, 'LETTER_BOUNDARY')[0];
      if (b !== undefined && a === undefined) {
        lost.push({
          merchant,
          label: v.label,
          text: v.text,
          rule: describeRule(b.ruleId),
          category: catName(b.categoryId),
        });
      }
    }
  }

  console.log(`\nPASS 2 — VARIANTS: ${merchants.length} real merchants x ${variantsOf('x').length} decorations = ${variantProbes} probes`);
  console.log(`  matches the new behaviour would LOSE: ${lost.length}`);
  const byLabel = new Map<string, number>();
  for (const l of lost) byLabel.set(l.label, (byLabel.get(l.label) ?? 0) + 1);
  for (const [label, n] of [...byLabel.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`     ${String(n).padStart(4)}  ${label}`);
  }
  for (const l of lost.slice(0, 12)) {
    console.log(`     e.g. "${l.text}" would stop matching ${l.rule} -> ${l.category}`);
  }

  // ---- PASS 3: collisions generated from the rule values --------------------
  const containsRules = ruleRows.filter((r) => r.matchOperator === 'CONTAINS');
  let collisionProbes = 0;
  const stillClaimed: { value: string; text: string; by: string }[] = [];
  const nowRefused = new Map<string, number>();

  for (const r of containsRules) {
    for (const c of collisionsOf(r.matchValue.toLowerCase().trim())) {
      collisionProbes += 1;
      const p = [probe(rules, c.text)];
      const b = applyRules(rules, p, 'SUBSTRING')[0];
      const a = applyRules(rules, p, 'LETTER_BOUNDARY')[0];
      if (b !== undefined && a === undefined) {
        nowRefused.set(r.matchValue, (nowRefused.get(r.matchValue) ?? 0) + 1);
      } else if (b !== undefined && a !== undefined) {
        stillClaimed.push({ value: r.matchValue, text: c.text, by: describeRule(a.ruleId) });
      }
    }
  }

  console.log(`\nPASS 3 — COLLISIONS: ${containsRules.length} CONTAINS rules, ${collisionProbes} constructed word-cutting probes`);
  console.log(`  wrongly claimed today, refused after:  ${[...nowRefused.values()].reduce((s, n) => s + n, 0)}`);
  console.log(`  across distinct rule values:           ${nowRefused.size}`);
  console.log(`  still claimed after the change:        ${stillClaimed.length}`);
  // A survivor is only a leak if the SAME rule still claims it. Where a
  // different rule does, at a clean word boundary, that is the matcher working:
  // "uber eatsing" is not claimed by "uber eats" any more, it is claimed by
  // "uber", which legitimately sits at a boundary.
  const sameRule = stillClaimed.filter((s) => s.by.includes(`"${s.value}"`));
  console.log(`     of which the SAME rule still claims:  ${sameRule.length}`);
  for (const s of stillClaimed.slice(0, 8)) {
    console.log(`     "${s.value}" -> "${s.text}" now via ${s.by}`);
  }

  console.log('\nWhat more real data would change: PASS 2 only. Pass 1 is bounded by');
  console.log('the merchants you have already visited and pass 3 is generated from the');
  console.log('rules themselves, so neither gets truer with more months of the same.');
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
