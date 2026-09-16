import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import {
  HOUSE_READINESS_KEY,
  isStoredReadinessConfig,
  parseReadiness,
  type StoredReadinessConfig,
} from '../src/lib/insights/readiness';
import { FRED_SERIES_ID } from '../src/lib/rates/mortgageRate';
import { arg, hasFlag } from './args';
import { databaseLabel } from './database-label';

/**
 * Declare, list and clear the house-readiness config — the typed assumptions
 * and the one declared knob behind the /insights readiness panel. Same
 * mechanism as `goals` and `accounts:cash`: a `Setting`, per-instance operator
 * config, so declaring is a DATA change: run it against the CLOUD, and the
 * nightly mirror brings it to local (a local run makes that mirror refuse).
 *
 *   npm run readiness
 *   npm run readiness -- --floor=2000 --rate=6.5 --term=30 --tax=1.2 \
 *     --insurance=0.5 --pmi=0.75 --closing=3 --down=20
 *   npm run readiness -- --rate=6.375 --as-of=2026-08-15
 *   npm run readiness -- --fetched-rate
 *   npm run readiness -- --clear
 *
 * The RATE is typed, never defaulted in code — absent config means the panel
 * does not render at all, the same opt-in shape as goals. `--as-of` records
 * the date the rate was read (defaults to today when --rate is given) and the
 * panel prints it beside the rate, because a rate with no date reads current
 * forever. Later runs merge onto the stored config, so a rate refresh is one
 * flag; the FIRST declaration must supply everything, listed loudly if not.
 *
 * `--fetched-rate` removes the typed rate: the panel then uses the FRED index
 * observation the sync stores (opt-in via FRED_API_KEY — see /providers), and
 * renders nothing until one exists. The rate-absent state is entered ONLY
 * through this flag: a first declaration that merely forgot --rate is refused,
 * never silently opted into the index. A typed rate always overrides the
 * fetched one — a national average is nobody's actual rate.
 *
 * The panel also needs a declared savings goal: the FUND the ceilings divide
 * is the first goal's assessed balance (`npm run goals`).
 */

/** flag → config field, in the order the listing prints. */
const FLAGS = [
  ['floor', 'savingsFloor', 'dollars/mo of saving that must survive the purchase', [0, 1_000_000], false],
  ['rate', 'ratePct', 'yearly mortgage rate in percent, like 6.5', [0, 30], true],
  ['term', 'termYears', 'mortgage term in years, like 30', [0, 100], true],
  ['tax', 'taxPctYr', 'property tax as %/yr of price', [0, 10], false],
  ['insurance', 'insurancePctYr', 'insurance as %/yr of price', [0, 10], false],
  ['pmi', 'pmiPctYr', 'PMI as %/yr of loan, charged below the down threshold', [0, 10], false],
  ['closing', 'closingPct', 'closing costs as % of price, paid from the fund', [0, 25], false],
  ['down', 'downPct', 'down payment target and no-PMI threshold, % of price', [0, 100], true],
] as const;

const AS_OF = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

function list(config: StoredReadinessConfig): void {
  console.log('House-readiness config:');
  for (const [flag, field, describe] of FLAGS) {
    if (field === 'ratePct' && config.ratePct === undefined) {
      console.log(
        `  --${flag.padEnd(9)} ${'(fetched)'.padEnd(10)} the FRED ${FRED_SERIES_ID} observation stored by sync — needs FRED_API_KEY`,
      );
      continue;
    }
    const suffix = field === 'ratePct' ? ` (as of ${String(config.asOf)})` : '';
    console.log(`  --${flag.padEnd(9)} ${String(config[field]).padEnd(10)} ${describe}${suffix}`);
  }
}

async function main(): Promise<void> {
  console.log(`\nDatabase: ${databaseLabel()}\n`);

  const row = await prisma.setting.findUnique({ where: { key: HOUSE_READINESS_KEY } });
  const stored = parseReadiness(row?.value ?? null);

  if (hasFlag('clear')) {
    if (row === null) {
      console.log('No house-readiness config declared — nothing to clear.');
      return;
    }
    await prisma.setting.delete({ where: { key: HOUSE_READINESS_KEY } });
    console.log('Cleared. The readiness panel will no longer render.');
    return;
  }

  const setting =
    FLAGS.some(([flag]) => arg(flag) !== undefined || hasFlag(flag)) ||
    arg('as-of') !== undefined ||
    hasFlag('as-of') ||
    hasFlag('fetched-rate');

  if (!setting) {
    if (stored === null) {
      console.log(
        row === null
          ? 'No house-readiness config declared. The panel renders only once every value below is set:'
          : 'The stored readiness.house value is unreadable by this checkout — inspect it by hand, or --clear and redeclare.',
      );
      if (row === null) {
        for (const [flag, , describe] of FLAGS) console.log(`  --${flag.padEnd(9)} ${describe}`);
        console.log('  --as-of    date the rate was read, YYYY-MM-DD (defaults to today with --rate)');
        console.log(
          `  --fetched-rate  use the FRED ${FRED_SERIES_ID} observation stored by sync instead of typing --rate (needs FRED_API_KEY)`,
        );
      }
      return;
    }
    list(stored);
    return;
  }

  // A stored value this checkout cannot parse is not a value it may overwrite
  // — merging onto it would silently discard whatever is there. --clear above
  // stays available as the deliberate escape hatch.
  if (row !== null && stored === null) {
    return fail(
      'The stored readiness.house value holds something this checkout cannot parse — refusing to\n' +
        'overwrite it. Update the checkout, inspect the Setting by hand, or --clear and redeclare.',
    );
  }

  // Space-form flags ("--rate 6.5") are invisible to arg() and the merge
  // would silently keep the old value — the same trap set-goals guards.
  for (const [flag] of FLAGS) {
    if (arg(flag) === undefined && hasFlag(flag)) return fail(`--${flag} takes the equals form: --${flag}=NUMBER.`);
  }
  if (arg('as-of') === undefined && hasFlag('as-of')) return fail('--as-of takes the equals form: --as-of=YYYY-MM-DD.');

  const next: Record<string, unknown> = { ...(stored ?? {}) };
  for (const [flag, field, describe, [lo, hi], exclusiveLo] of FLAGS) {
    const raw = arg(flag);
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || (exclusiveLo ? value <= lo : value < lo) || value > hi) {
      return fail(
        `--${flag}=${raw} is out of range — expected ${describe}, ${exclusiveLo ? 'above' : 'at least'} ${lo} and at most ${hi}.`,
      );
    }
    next[field] = value;
  }

  // The rate-absent state is entered ONLY through this flag — deliberate,
  // never a side effect of forgetting --rate. It removes the typed pair from
  // the merged config; the panel then reads the FRED observation sync stores.
  if (hasFlag('fetched-rate')) {
    if (arg('rate') !== undefined || arg('as-of') !== undefined || hasFlag('as-of')) {
      return fail('--fetched-rate and --rate/--as-of contradict — pick one rate source.');
    }
    delete next.ratePct;
    delete next.asOf;
  }

  const asOf = arg('as-of');
  if (asOf !== undefined) {
    if (!AS_OF.test(asOf) || Number.isNaN(Date.parse(asOf))) {
      return fail('--as-of must be a real date like 2026-08-15.');
    }
    if (arg('rate') === undefined && stored?.ratePct === undefined) {
      return fail('--as-of dates the typed rate — give it alongside --rate.');
    }
    next.asOf = asOf;
  } else if (arg('rate') !== undefined) {
    // A typed rate with no date reads current forever; stamp today.
    next.asOf = new Date().toISOString().slice(0, 10);
    console.log(`Note: --as-of not given — recording the rate as read today (${String(next.asOf)}).`);
  }

  const missingRate =
    next.ratePct === undefined &&
    !hasFlag('fetched-rate') &&
    (stored === null || stored.ratePct !== undefined);
  if (!isStoredReadinessConfig(next) || missingRate) {
    const missing = FLAGS.filter(([, field]) =>
      field === 'ratePct' ? missingRate : next[field] === undefined,
    ).map(([flag, field]) => (field === 'ratePct' ? '--rate (or --fetched-rate)' : `--${flag}`));
    return fail(
      missing.length > 0
        ? `The first declaration must supply every value. Missing: ${missing.join(', ')}.`
        : 'The combined config is invalid — check the ranges above and try again.',
    );
  }

  const value = JSON.stringify(next);
  await prisma.setting.upsert({
    where: { key: HOUSE_READINESS_KEY },
    create: { key: HOUSE_READINESS_KEY, value },
    update: { value },
  });
  console.log(stored === null ? 'Declared.\n' : 'Updated.\n');
  list(next);
  console.log(
    '\nThe panel renders on /insights for the month being lived in, and needs a declared\n' +
      'savings goal (npm run goals) — its fund is what the ceilings divide.',
  );
  if (next.ratePct === undefined) {
    console.log(
      'No typed rate: the panel additionally waits for a stored FRED observation —\n' +
        'set FRED_API_KEY in this instance\'s environment and run a sync.',
    );
  }
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
