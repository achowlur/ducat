/**
 * One-time repair for merchant strings imported before normalizeMerchant
 * unwrapped payment-processor prefixes ("TST*BUCKS" -> "bucks").
 *
 *   npm run repair:merchants            # dry run — lists what would change
 *   npm run repair:merchants -- --apply # writes
 *
 * Normalization happens at IMPORT time, so a change to the normalizer only
 * reaches new rows. Everything already stored keeps its old form, which means
 * it goes on grouping under the processor rather than the restaurant and goes
 * on missing every brand rule written for the real name.
 *
 * Rules are rewritten too, and for the same reason in reverse: a rule whose
 * matchValue still carries the prefix would silently stop matching the moment
 * imports stop producing one. "sq *sorrel" becomes "sorrel" and keeps working.
 *
 * Nothing here re-categorizes. Rules only ever write on a match, so no row
 * loses the category it has; re-running `npm run rules:install` afterwards is
 * what lets the newly-visible names pick up better ones.
 */
import 'dotenv/config';
import { hasTransactionType, normalizeMerchant } from '../src/lib/connectors/normalize';
import { prisma } from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

/** Same floor the grouped review uses: shorter than this matches everything. */
const MIN_RULE_VALUE = 3;

/**
 * Re-running the normalizer over a stored merchant can only ever reduce what is
 * already there, and a connector sometimes hands over a payee the bank has
 * already mangled: three rent-portal charges arrived as "harborwaymgmt web
 * bqxrt marlowe brennan" from a description that plainly reads "PL*HarborwayMgmt
 * WEB PMTS 070226 BQXRT8 Marlowe Brennan". The marker was never in the payee, so
 * there was nothing left to match, and nine sibling rows collapsed while those
 * three did not.
 *
 * The description can rescue them, but only where it is the SAME NAME with the
 * bookkeeping cut off — which is a prefix test, not a length one. Length alone
 * looked reasonable and was wrong on the first dry run: it rewrote a clean
 * "chase credit card" into the bank's abbreviation "chase credit crd", one
 * character shorter and plainly worse. A prefix cannot do that, because the two
 * spellings diverge at "car"/"crd", while "harborwaymgmt" is a prefix of
 * "harborwaymgmt web bqxrt marlowe brennan" exactly as it should be.
 *
 * Ordinary rows never reach the test at all: no marker in the description, no
 * substitution. That is what keeps a feed's good payee ("shell oil") from being
 * replaced by its own descriptor.
 */
function bestMerchant(stored: string, description: string): string {
  const fromStored = normalizeMerchant(stored);
  if (!hasTransactionType(description)) return fromStored;
  const fromDescription = normalizeMerchant(description);
  if (fromDescription.length < MIN_RULE_VALUE) return fromStored;
  // Shorter AND a prefix: the same payee, with the bank's columns removed.
  return fromDescription.length < fromStored.length && fromStored.startsWith(fromDescription)
    ? fromDescription
    : fromStored;
}

async function main(): Promise<void> {
  const txns = await prisma.transaction.findMany({
    select: { id: true, normalizedMerchant: true, description: true },
  });
  const txnFixes = txns
    .map((t) => ({
      id: t.id,
      was: t.normalizedMerchant,
      now: bestMerchant(t.normalizedMerchant, t.description),
    }))
    .filter((f) => f.now !== f.was && f.now !== '');

  const rules = await prisma.rule.findMany({
    where: { matchField: 'MERCHANT', matchOperator: { in: ['CONTAINS', 'EQUALS'] } },
    select: { id: true, matchValue: true, matchOperator: true },
  });
  const taken = new Set(rules.map((r) => `${r.matchOperator}|${r.matchValue}`));
  const ruleFixes: { id: string; was: string; now: string }[] = [];
  const ruleSkips: { was: string; now: string; why: string }[] = [];
  for (const r of rules) {
    const now = normalizeMerchant(r.matchValue);
    if (now === r.matchValue) continue;
    if (now.length < MIN_RULE_VALUE) {
      ruleSkips.push({ was: r.matchValue, now, why: `under ${MIN_RULE_VALUE} characters` });
      continue;
    }
    if (taken.has(`${r.matchOperator}|${now}`)) {
      ruleSkips.push({ was: r.matchValue, now, why: 'another rule already matches that' });
      continue;
    }
    taken.add(`${r.matchOperator}|${now}`);
    ruleFixes.push({ id: r.id, was: r.matchValue, now });
  }

  const preview = (label: string, fixes: { was: string; now: string }[], total: number) => {
    console.log(`${label} ${fixes.length} of ${total}`);
    for (const f of fixes.slice(0, 10)) console.log(`  ${f.was}  ->  ${f.now}`);
    if (fixes.length > 10) console.log(`  … and ${fixes.length - 10} more`);
  };
  preview('Transactions to re-normalize:', txnFixes, txns.length);
  preview('Rules to re-normalize:      ', ruleFixes, rules.length);
  if (ruleSkips.length > 0) {
    console.log(`Rules left alone: ${ruleSkips.length}`);
    for (const s of ruleSkips) console.log(`  ${s.was}  (would be "${s.now}" — ${s.why})`);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with `-- --apply` to write these changes.');
    return;
  }
  for (const f of txnFixes) {
    await prisma.transaction.update({ where: { id: f.id }, data: { normalizedMerchant: f.now } });
  }
  for (const f of ruleFixes) {
    await prisma.rule.update({ where: { id: f.id }, data: { matchValue: f.now } });
  }
  console.log(`\nRe-normalized ${txnFixes.length} transactions and ${ruleFixes.length} rules.`);
  console.log('Categories are unchanged. Run `npm run rules:install` to re-apply rules over the new names.');
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
