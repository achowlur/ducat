import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { parseGoals, SAVINGS_GOALS_KEY, type SavingsGoal } from '../src/lib/insights/goals';
import { arg, hasFlag } from './args';
import { databaseLabel } from './database-label';

/**
 * Declare, list and remove savings goals — "House deposit, $155,503.76 by Jun
 * 2028" — shown on /insights against the observed savings rate.
 *
 * A goal NOMINATES the accounts whose balances are its fund, because which
 * balances count is exactly the thing the data cannot say: cash as a whole
 * breathes by a rent cycle and counts the emergency fund toward the house.
 * Same mechanism as `accounts:cash` — a `Setting`, per-instance operator
 * config, so declaring is a DATA change and has to be run once per database.
 *
 *   npm run goals
 *   npm run goals -- --add --name="House deposit" --target=60000 --by=2028-06 --accounts="savings,money market"
 *   npm run goals -- --add --name="House deposit" --house-price=385000 --by=2028-06 --accounts="money market"
 *   npm run goals -- --remove=house
 *
 * `--accounts` is comma-separated; each entry must uniquely match one account
 * by externalId or name fragment, the way `accounts:cash` resolves them.
 *
 * `--house-price` derives the target as CASH NEEDED — (--down + --closing)%
 * of the price, defaulting 20 and 3 — prints the arithmetic, and stores only
 * the resulting number. The percentages are flags, not constants, because a
 * down payment is market- and loan-product-specific; what is stored is the
 * dollar figure the operator saw and confirmed, never the formula.
 */

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

function slugify(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'goal';
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}

async function save(goals: SavingsGoal[]): Promise<void> {
  const value = JSON.stringify(goals);
  await prisma.setting.upsert({
    where: { key: SAVINGS_GOALS_KEY },
    create: { key: SAVINGS_GOALS_KEY, value },
    update: { value },
  });
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log(`\nDatabase: ${databaseLabel()}\n`);

  const accounts = await prisma.account.findMany({ orderBy: { institution: 'asc' } });
  const row = await prisma.setting.findUnique({ where: { key: SAVINGS_GOALS_KEY } });
  let goals = parseGoals(row?.value ?? null);

  const resolveAccount = (needle: string) => {
    const n = needle.trim().toLowerCase();
    return accounts.filter(
      (a) => a.externalId.toLowerCase().includes(n) || a.name.toLowerCase().includes(n),
    );
  };

  if (hasFlag('add')) {
    const name = arg('name')?.trim() ?? '';
    const by = arg('by') ?? '';
    const needles = (arg('accounts') ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);

    if (name.length === 0) return fail('--name is required.');

    // Two ways to state the target, never both: a dollar amount, or a house
    // price it is DERIVED from as cash needed — (down% + closing%) × price.
    // The derivation runs once, here, in front of the operator; only the
    // resulting number is stored, so nothing can re-derive it at render.
    const targetArg = arg('target');
    const priceArg = arg('house-price');
    // A space-form flag ("--down 10") is a bare token arg() cannot see, and
    // for down/closing the defaults would swallow it SILENTLY — the one
    // malformed-flag path that stores a plausible wrong dollar figure instead
    // of refusing. Caught loudly for all four numeric flags.
    for (const f of ['target', 'house-price', 'down', 'closing'] as const) {
      if (arg(f) === undefined && hasFlag(f)) return fail(`--${f} takes the equals form: --${f}=NUMBER.`);
    }
    if (targetArg !== undefined && priceArg !== undefined) {
      return fail('Give --target OR --house-price, not both.');
    }
    if (targetArg === undefined && priceArg === undefined) {
      return fail('One of --target or --house-price is required.');
    }
    if (priceArg === undefined && (arg('down') !== undefined || arg('closing') !== undefined)) {
      return fail('--down/--closing only mean something with --house-price.');
    }
    let target: number;
    if (priceArg !== undefined) {
      const price = Number(priceArg);
      const down = Number(arg('down') ?? '20');
      const closing = Number(arg('closing') ?? '3');
      if (!Number.isFinite(price) || price <= 0) return fail('--house-price must be a positive dollar amount.');
      if (!Number.isFinite(down) || down <= 0 || down > 100) return fail('--down must be a percentage in (0, 100].');
      if (!Number.isFinite(closing) || closing < 0 || closing > 100) return fail('--closing must be a percentage in [0, 100].');
      // The target IS the sum of the two printed components. Rounding the
      // combined percentage instead can disagree with them by a cent, and two
      // totals on one screen is the June-donut bug class.
      const downAmount = Math.round(price * down) / 100;
      const closingAmount = Math.round(price * closing) / 100;
      target = Math.round((downAmount + closingAmount) * 100) / 100;
      console.log(`Cash needed for a ${price.toFixed(2)} house:`);
      console.log(`  ${down}% down      ${downAmount.toFixed(2)}`);
      console.log(`  ${closing}% closing    ${closingAmount.toFixed(2)}`);
      console.log(`  target        ${target.toFixed(2)} — stored as this number; the derivation is not kept.\n`);
    } else {
      target = Number(targetArg);
    }
    if (!Number.isFinite(target) || target <= 0) return fail('--target (or --house-price) must be a positive dollar amount.');
    if (!MONTH_KEY.test(by)) return fail('--by must be a month like 2028-06.');
    if (needles.length === 0) return fail('--accounts is required: comma-separated account names or externalIds.');

    const accountIds: string[] = [];
    for (const needle of needles) {
      const hits = resolveAccount(needle);
      if (hits.length !== 1) {
        return fail(
          hits.length === 0
            ? `No account matches "${needle}".`
            : `"${needle}" matches ${hits.length} accounts: ${hits.map((h) => h.name).join(', ')}. Be more specific.`,
        );
      }
      accountIds.push(hits[0].id);
    }

    if (by < new Date().toISOString().slice(0, 7)) {
      console.log(`Note: ${by} is already in the past — the goal will show as behind from day one.`);
    }
    const shared = goals.filter((g) => g.accountIds.some((id) => accountIds.includes(id)));
    if (shared.length > 0) {
      console.log(
        `Note: shares an account with ${shared.map((g) => `"${g.name}"`).join(', ')} — the same dollars will count as saved toward both.`,
      );
    }

    const goal: SavingsGoal = {
      id: slugify(name, new Set(goals.map((g) => g.id))),
      name,
      target,
      targetMonth: by,
      accountIds,
    };
    goals = [...goals, goal];
    await save(goals);
    console.log(`Added: ${goal.name} (${goal.id})\n`);
  } else if (arg('remove') !== undefined) {
    const n = (arg('remove') ?? '').trim().toLowerCase();
    if (n.length === 0) return fail('--remove needs a goal id or name fragment.');
    const hits = goals.filter((g) => g.id.includes(n) || g.name.toLowerCase().includes(n));
    if (hits.length !== 1) {
      return fail(
        hits.length === 0
          ? `No goal matches "${n}".`
          : `"${n}" matches ${hits.length} goals: ${hits.map((g) => g.name).join(', ')}. Be more specific.`,
      );
    }
    goals = goals.filter((g) => g.id !== hits[0].id);
    await save(goals);
    console.log(`Removed: ${hits[0].name}\n`);
  }

  if (goals.length === 0) {
    console.log('No savings goals declared.');
    return;
  }

  const byId = new Map(accounts.map((a) => [a.id, a]));
  console.log('Savings goals:');
  for (const g of goals) {
    const held = g.accountIds.map((id) => byId.get(id)).filter((a) => a !== undefined);
    const saved = held.reduce((s, a) => s + Number(a.balance), 0);
    const missing = g.accountIds.length - held.length;
    console.log(`  ${g.id}  ${g.name} — ${g.target.toFixed(2)} by ${g.targetMonth}`);
    console.log(`      saved ${saved.toFixed(2)} across: ${held.map((a) => a.name).join(', ') || '(none)'}`);
    if (missing > 0) console.log(`      MISSING: ${missing} nominated account(s) no longer exist`);
  }
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
