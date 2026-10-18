/**
 * `npm run audit:figures`: every headline projection beside what it stands
 * on, read from a COPY of a verified backup. Read-only toward every real
 * database.
 *
 * The projections that went wrong (bonuses averaged in as a habit, a month
 * from before a card's records averaged as whole, raw cash with a card bill
 * open, a trip counted as a month's burn) were each found by the operator
 * reading a figure on screen and asking whether it made sense. This prints,
 * for each one, the months it used, which it left out and why, their
 * coverage, the one-off income and top-ups it adjusted for, and the figure
 * it landed on, so that review is a command rather than an afternoon.
 *
 * It copies the newest canonical backup in data/backups/ (or `--from=` one)
 * into a temporary folder, regenerates insights there with THIS checkout's
 * code (so the figures are what the branch would show), reads them through
 * the same loaders the pages use, prints, and deletes the copy. It never
 * reads DATABASE_URL, so it cannot reach the cloud or the live local file.
 *
 * Its output is REAL FIGURES: read them in the terminal and keep them out of
 * commits, pull requests and issues (the repository is public).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { arg } from './args';
import { auditSource } from './auditFigures';
import type { CashFlowTrendPayload, SpendingByCategoryPayload } from '../src/types/contracts';

const DIR = join('data', 'backups');
const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? 'n/a' : `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

/**
 * The copy, and the report run in a CHILD process against it: the database
 * client holds the file until its process exits (on Windows a delete fails
 * until then), so the parent deletes the copy once the child is gone.
 */
function main(): void {
  const source = auditSource(arg('from'), readdirSync(DIR), DIR);
  if ('refusal' in source) throw new Error(source.refusal);
  const dir = mkdtempSync(join(tmpdir(), 'ducat-audit-'));
  const copy = join(dir, 'audit.db');
  try {
    copyFileSync(source.path, copy);
    console.log(`\nDatabase: COPY of ${source.path} (in ${dir}, deleted at the end)`);
    console.log('These are REAL figures. Read them here; never paste them into a commit, a pull request or an issue.\n');
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: `file:${copy.replace(/\\/g, '/')}` };
    delete env.TURSO_AUTH_TOKEN;
    const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1], `--child=${copy}`], { stdio: 'inherit', env });
    process.exitCode = child.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** The report itself, against the parent's temporary copy only: never a database someone named. */
async function report(copy: string): Promise<void> {
  const folder = dirname(resolve(copy));
  if (!basename(folder).startsWith('ducat-audit-') || dirname(folder) !== resolve(tmpdir())) {
    throw new Error('--child is internal: it names the temporary copy the audit made.');
  }
  const { prisma } = await import('../src/lib/prisma');
  try {
    const { generateInsights } = await import('../src/lib/insights/engine');
    const { getOverviewData } = await import('../src/lib/ui/overview');
    const { getInsightsPageData } = await import('../src/lib/ui/insights');
    const { getAccountCoverage } = await import('../src/lib/ui/coverage');
    const { periodCoverage } = await import('../src/lib/insights/coverage');
    const { monthlyRows, ofType } = await import('../src/lib/ui/insightRows');
    const { NEW_PAY_KEY, parseNewPay, payLevels } = await import('../src/lib/ui/payLevel');

    await generateInsights(prisma, { granularity: 'MONTH' });
    console.log("Insights regenerated on the copy with this checkout's code.\n");

    const [overview, insights, coverage, rows, newPay] = await Promise.all([
      getOverviewData(),
      getInsightsPageData(),
      getAccountCoverage(),
      prisma.insight.findMany({ where: { type: { in: ['CASH_FLOW_TREND', 'SPENDING_BY_CATEGORY'] } } }),
      prisma.setting.findUnique({ where: { key: NEW_PAY_KEY } }),
    ]);
    const monthly = monthlyRows(rows);
    const flows = ofType<CashFlowTrendPayload>(monthly, 'CASH_FLOW_TREND');
    const spending = new Map(ofType<SpendingByCategoryPayload>(monthly, 'SPENDING_BY_CATEGORY').map((r) => [r.period, r.payload]));
    const pay = payLevels(flows.flatMap((r) => r.payload.paychecks ?? []), parseNewPay(newPay?.value ?? null));
    const current = overview.currentPeriod;
    const window = overview.runwayWindow;

    console.log('== The months every projection averages (savings pace, readiness, runway)');
    console.log(
      `   ${pad('month', 8)} ${pad('kept', 6)} ${pad('cover', 6)} ${padL('income', 11)} ${padL('one-off', 10)} ${padL('top-up', 9)} ${padL('spending', 11)} ${padL('everyday', 11)} ${padL('net, pace', 11)}`,
    );
    const shown = flows.filter((r) => r.period < current).slice(-8);
    for (const r of shown) {
      const c = periodCoverage(r.period, coverage);
      const s = spending.get(r.period);
      const kept = window.used.includes(r.period)
        ? window.short.includes(r.period) ? 'short' : 'yes'
        : window.dropped.some((d) => d.period === r.period) ? 'OUT' : '-';
      const topUp = pay.topUps[r.period] ?? 0;
      const oneOff = r.payload.oneOffIncome ?? 0;
      console.log(
        `   ${pad(r.period, 8)} ${pad(kept, 6)} ${pad(`${c.covered}/${c.total}`, 6)} ${padL(usd(r.payload.income), 11)} ${padL(usd(oneOff), 10)} ${padL(usd(topUp), 9)} ${padL(usd(s?.totalSpending), 11)} ${padL(usd(s?.everydayAfterDay?.[0]), 11)} ${padL(usd(r.payload.net + topUp - oneOff), 11)}`,
      );
    }
    console.log('   kept: yes = averaged; short = averaged, but some account has no records that month; OUT = left out, not comparable.');
    for (const d of window.dropped) console.log(`   ${d.period} left out: ${d.missing} of ${d.total} accounts' records begin after it starts.`);
    const oneOffs = flows.filter((r) => window.used.includes(r.period)).flatMap((r) => r.payload.oneOffPay ?? []);
    console.log(`   One-off income left out of the paces: ${oneOffs.length === 0 ? 'none' : oneOffs.map((o) => `${usd(o.amount)} ${o.date} ${o.payer}`).join('; ')}`);
    for (const c of pay.changes) console.log(`   Pay counted at ${usd(c.to)} since ${c.since} (${c.payer}, from ${usd(c.from)}${c.told ? ', as told' : ''}).`);
    for (const p of pay.pending) console.log(`   Pending pay: ${usd(p.amount)} on ${p.date} (${p.payer}, was ${usd(p.from)}), counted as itself.`);

    console.log('\n== Overview: cash runway');
    const b = overview.balances;
    console.log(`   Cash ${usd(b.cash)}, cards ${usd(b.cards)}, cash after cards ${usd(b.cash + b.cards)}.`);
    if (overview.runway === null) console.log('   Refused (too few months, nothing spent, or no cash after cards).');
    else
      console.log(
        `   ${overview.runway.months} months at ${usd(overview.runway.monthlySpending)}/mo, the middle of ${overview.runway.basisMonths} ${overview.runwayEveryday ? 'everyday' : 'total (rows predate the everyday series)'} months; they ran ${usd(overview.runway.low)} to ${usd(overview.runway.high)}.`,
      );

    if (insights === null) {
      console.log('\n/insights has no month to show.');
      return;
    }
    console.log('\n== /insights: savings goals');
    if (insights.goals.length === 0) console.log('   None declared.');
    for (const g of insights.goals) {
      console.log(
        `   ${g.goal.name}: saved ${usd(g.saved)}${g.cardsOwed > 0 ? ` after ${usd(g.cardsOwed)} on cards` : ''} of ${usd(g.goal.target)}; pace ${usd(g.monthlyRate)}/mo over ${g.basisMonths} months; lands ${g.landsMonth ?? 'n/a'}${g.goal.targetMonth ? ` (aimed ${g.goal.targetMonth}, ${g.deltaMonths ?? 'n/a'} months)` : ''}; refusal ${g.refusal ?? 'none'}.`,
      );
      if (g.observedFundGrowth !== null) console.log(`     Reconciliation: the fund grew ${usd(g.observedFundGrowth)}/mo over the same months.`);
    }

    console.log('\n== /insights: house readiness');
    const r = insights.readiness;
    if (r === null) console.log('   Not shown (no config, no goal to fund it, or no rate).');
    else {
      const earned = flows
        .filter((f) => window.used.includes(f.period))
        .map((f) => Object.values(f.payload.earnedByAccount ?? {}).reduce((s, n) => s + n, 0));
      console.log(
        `   Income ${usd(r.incomeMean)}/mo less non-housing ${usd(r.nonHousingMean)}/mo less floor ${usd(r.config.savingsFloor)}/mo = budget ${usd(r.pitiBudget)}/mo over ${r.basisMonths} months; refusal ${r.refusal ?? 'none'}.`,
      );
      console.log(`   Interest and dividends inside income in those months (the fund's own is left out): ${earned.map((n) => usd(n)).join(', ') || 'none'}.`);
      console.log(
        `   Fund ${usd(r.fund)}: fund-limited ${usd(r.fundLimitedPrice)}, payment-limited ${usd(r.paymentLimitedPrice)}, binding ${r.bindingConstraint ?? 'n/a'}, balanced ${usd(r.balancedPrice)}.`,
      );
    }

    console.log('\n== /insights: net worth goal');
    const n = insights.netWorthGoal;
    if (n === null) console.log('   None declared.');
    else {
      console.log(
        `   Net worth ${usd(n.netWorth)} of ${usd(n.goal.target)}; from ${n.anchor ?? 'n/a'}: pace ${usd(n.pace)}/mo over ${n.paceMonths} months (${n.paceUncertainMonths} partly estimated), a month before ${usd(n.previousPace)}.`,
      );
      console.log(`   Left out of the pace: ${n.paceLeavesOut.length === 0 ? 'nothing' : n.paceLeavesOut.map((o) => `${usd(o.amount)} ${o.date} ${o.payer}`).join('; ')}.`);
      console.log(
        `   Invested ${usd(n.invested)}, deposit ${usd(n.contribution)}/mo (a year ago ${usd(n.contributionYearAgo)}), unmatched ${usd(n.unmatchedDeposit)}; cash real yield ${n.cash === null ? 'n/a' : `${n.cash.realPct}%`}.`,
      );
      console.log(`   Saving alone lands ${n.saving?.lands ?? 'n/a'} (shift ${n.saving?.shift ?? 'n/a'}); with markets ${n.markets?.lands ?? 'n/a'} (shift ${n.markets?.shift ?? 'n/a'}); refusal ${n.refusal ?? 'none'}.`);
    }

    console.log('\n== /insights: this month');
    const p = insights.pace;
    if (p === null) console.log('   No pace call (not the month being lived in, or no spending row).');
    else
      console.log(
        `   Day ${p.dayOfPeriod} of ${p.daysInPeriod}: spent ${usd(p.spentSoFar)}, the rest adds ${usd(p.typicalRest)} (${p.basis ?? 'refused'} over ${p.basisCount} months, ${p.basisMissingAccounts} missing accounts at most), projected ${usd(p.projected)}; refusal ${p.refusal ?? 'none'}.`,
      );
    const recurring = insights.groups.find((g) => g.note !== null);
    console.log(`   Recurring charges: ${recurring?.note ?? 'no yearly total shown'}; next 30 days ${usd(insights.commitments?.total)}.`);
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

const child = arg('child');
(child === undefined ? Promise.resolve().then(main) : report(child)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
