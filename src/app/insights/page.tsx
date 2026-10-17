import Link from "next/link";
import { CoverageNotice } from "../../components/CoverageNotice";
import { DismissButton } from "../../components/DismissButton";
import { getInsightsPageData, type InsightRow } from "../../lib/ui/insights";
import { GOAL_RATE_MIN_MONTHS } from "../../lib/insights/goals";
import { monthlyPiti, type ReadinessAssessment } from "../../lib/insights/readiness";
import { money, monthLabel, shortDate, titleCase } from "../../lib/ui/format";
import { ASSUMED_CHIP, CHIP, FIELD_LABEL, PageTitle, PROJECTED_CHIP, SectionTitle, SubsectionTitle } from "../../components/ui/headings";
import { NetWorthGoalPanel } from "../../components/NetWorthGoalPanel";
import { SavingsGoalCard } from "../../components/goals/SavingsGoalCard";
import { Fig, Lead } from "../../components/ui/figure";
import type { Pace } from "../../lib/insights/pace";
import { withDatabaseNotice } from "../../components/DatabaseNotice";

export const dynamic = "force-dynamic";

/**
 * Month step. Below md the box grows to a 44px touch target; at md and up it
 * is the original px-1 glyph, so the desktop header is untouched.
 */
const ARROW =
  "inline-block px-1 text-center text-faint hover:text-ink max-md:min-h-[44px] max-md:min-w-[44px] max-md:-my-3 max-md:py-3";

const CHIP_CLASS: Record<InsightRow["tone"], string> = {
  neg: "bg-neg text-paper",
  pos: "bg-pos text-paper",
  neutral: "bg-chip text-acc",
};

/** A row with no chip keeps its tone as a small mark, so direction survives. */
const TONE_MARK: Record<Exclude<InsightRow["tone"], "neutral">, string> = {
  neg: "bg-neg",
  pos: "bg-pos",
};

/** A live plan's next charge: "in 20d · Nov 5" inside the window, the date beyond it, then the amount. */
function NextCharge({ next }: { next: { date: Date; daysAway: number; amount: number } }) {
  return (
    <span className="whitespace-nowrap font-money text-[0.78rem] tabular">
      <span className="text-faint">
        {next.daysAway <= 30
          ? `${next.daysAway === 0 ? "today" : `in ${next.daysAway}d`} · ${shortDate(next.date)}`
          : `next ${shortDate(next.date)}`}
      </span>{" "}
      {money(next.amount)}
    </span>
  );
}

/**
 * An archive row: a NAME plus a column of FACTS, a chip only where it carries
 * a fact, and Dismiss. A live recurring plan's next charge LEADS its facts;
 * its amount is already the price fact, so it is not printed twice.
 */
function InsightRowView({ row }: { row: InsightRow }) {
  const next = row.next;
  const facts =
    next === undefined
      ? row.facts
      : [
          `next ${shortDate(next.date)}${next.daysAway <= 30 ? `, ${next.daysAway === 0 ? "today" : `in ${next.daysAway}d`}` : ""}`,
          ...row.facts,
        ];
  return (
    <div
      className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-rule py-2 text-[0.85rem] last:border-b-0 max-md:py-3 ${
        row.dismissed ? "opacity-50" : ""
      }`}
    >
      {row.chip !== null ? (
        <span className={`${CHIP} ${CHIP_CLASS[row.tone]}`}>{row.chip}</span>
      ) : row.tone !== "neutral" ? (
        <span aria-hidden="true" className={`inline-block h-[10px] w-[10px] rounded-[2px] ${TONE_MARK[row.tone]}`} />
      ) : null}
      <span className="min-w-0 flex-1">{row.text}</span>
      {facts.length > 0 && (
        <span className="whitespace-nowrap font-money text-[0.78rem] tabular text-faint max-md:order-last max-md:basis-full max-md:whitespace-normal">
          {facts.join(" · ")}
        </span>
      )}
      <DismissButton insightId={row.id} dismissed={row.dismissed} />
    </div>
  );
}

/** Dollar figure in the panel's money face, prefixed ~ where it is solved. */
function Money({ n, about = false }: { n: number; about?: boolean }) {
  return (
    <span className="font-money tabular">
      {about ? "~" : ""}
      {money(n)}
    </span>
  );
}

/**
 * House readiness: the estimated mortgage budget and the two price ceilings,
 * the binding one named. A READINESS signal, deliberately NOT lender math —
 * nothing here speaks of approval, and the constraint wording is FUND-limited,
 * never "deposit-limited": the binding constraint is the DECLARED FUND, and
 * phrasing it as incapacity is wrong for anyone holding a brokerage that could
 * fund a deposit tomorrow (docs/backlog.md records the design).
 *
 * Refusals render rather than hide, and the fund-limited ceiling survives both
 * of them — it depends on nothing refused. The typed assumptions always render
 * with their values and ASSUMED chips, because they are what every number on
 * the panel silently leans on; the rate carries its as-of date so it cannot
 * read current forever.
 */
/** "$421k", "$1.2m": a price estimated from averages, to the precision it has. */
function approx(n: number): string {
  return n >= 1e6 ? `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}m` : `$${Math.round(n / 1e3)}k`;
}
/** Whole dollars: a monthly estimate's cents are noise. */
const dollars = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function ReadinessBlock({
  r,
  fundName,
  targetHousePrice,
  depositLands,
}: {
  r: ReadinessAssessment;
  fundName: string | null;
  targetHousePrice: number | null;
  /** When the fund's goal is projected to be reached ("2029-01"); null when it has no date. */
  depositLands: string | null;
}) {
  const c = r.config;
  // The house the operator picked, with its cash saved in full: what it
  // needs, and the payment that leaves.
  const target =
    targetHousePrice === null
      ? null
      : (() => {
          const cash = (targetHousePrice * (c.downPct + c.closingPct)) / 100;
          return { price: targetHousePrice, cash, payment: monthlyPiti(targetHousePrice, c, cash) };
        })();
  const monthsWord = (n: number) => (n === 1 ? "month" : "months");
  const fundLabel = fundName === null ? "declared fund" : `${fundName} fund`;
  const fundCaps = (
    <>
      the <Money n={r.fund} /> {fundLabel} caps you at <Money n={r.fundLimitedPrice} about /> (covering{" "}
      {c.downPct}% down + {c.closingPct}% closing)
    </>
  );
  return (
    <div className="border-b border-rule py-2.5 text-[0.85rem] last:border-b-0 max-md:py-3">
      {r.refusal === "TOO_FEW_MONTHS" ? (
        <p className="leading-relaxed text-faint">
          {r.basisMonths === 0
            ? "No complete months of history yet"
            : `Only ${r.basisMonths} complete ${monthsWord(r.basisMonths)} of history`},{" "}
          too few to average income and non-housing spending ({GOAL_RATE_MIN_MONTHS} needed). What
          stands regardless: {fundCaps}.
        </p>
      ) : r.refusal === "FLOOR_EXCEEDS_RESIDUAL" ? (
        <p className="leading-relaxed text-faint">
          Income <Money n={r.incomeMean ?? 0} about />
          /mo minus non-housing spending <Money n={r.nonHousingMean ?? 0} about />
          /mo, over your last {r.basisMonths} complete {monthsWord(r.basisMonths)}, leaves no mortgage
          budget once the <Money n={c.savingsFloor} />
          /mo savings floor you declared is kept: it comes to{" "}
          <span className="font-money tabular text-ink">{money(r.pitiBudget ?? 0)}</span>/mo, so the
          floor is the reason there is no payment ceiling. What stands regardless: {fundCaps}.
        </p>
      ) : (
        <>
          {/* The VERDICT first, on the house the operator picked: when its
              cash is saved and whether its payment fits the budget. Then what
              the plan affords today, the binding ceiling named. The budget's
              arithmetic and the other ceiling are a tap away. */}
          {target !== null && (
            <p className="leading-relaxed">
              The <span className="font-money tabular">{approx(target.price)}</span> house needs{" "}
              <span className="font-money tabular">{dollars(target.cash)}</span> cash
              {depositLands !== null && (
                <>
                  , saved by <span className="font-semibold">~{monthLabel(depositLands)}</span>
                </>
              )}
              , and about <span className="font-money tabular">{dollars(target.payment)}</span>/mo
              {target.payment > (r.pitiBudget ?? 0) ? (
                <span className="text-[color:var(--warn-ink)]">
                  , over your ~<span className="font-money tabular">{dollars(r.pitiBudget ?? 0)}</span>/mo budget
                </span>
              ) : (
                <>
                  , within your ~<span className="font-money tabular">{dollars(r.pitiBudget ?? 0)}</span>/mo budget
                </>
              )}
              .
            </p>
          )}
          <p className="pt-1 leading-relaxed text-faint">
            Today you could buy about{" "}
            <span className="font-money tabular text-ink">
              {approx(r.bindingConstraint === "FUND" ? r.fundLimitedPrice : (r.paymentLimitedPrice ?? 0))}
            </span>
            , {r.bindingConstraint === "FUND" ? "fund-limited" : "payment-limited"}
            {r.balancedPrice !== null && r.bindingConstraint === "FUND" && (
              <>
                ; once the fund catches up, about{" "}
                <span className="font-money tabular text-ink">{approx(r.balancedPrice)}</span>, where it meets what the
                payment carries
              </>
            )}
            .
          </p>
          <details className="group pt-1 text-[0.78rem] text-faint">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 max-md:min-h-[44px] [&::-webkit-details-marker]:hidden">
              How this is worked out
              <span aria-hidden="true" className="text-[0.7rem] transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>
            <div className="grid gap-1.5 pt-1.5 leading-relaxed">
              <p>
                The {fundLabel}, <Money n={r.fund} />, covers {c.downPct}% down + {c.closingPct}% closing on up to{" "}
                <Money n={r.fundLimitedPrice} about />; the budget carries the payment on up to{" "}
                <Money n={r.paymentLimitedPrice ?? 0} about />
                {r.balancedPrice !== null && r.cashNeededAtBalance !== null && (
                  <>
                    . They meet at <Money n={r.balancedPrice} about />, with <Money n={r.cashNeededAtBalance} about /> cash
                  </>
                )}
                .
              </p>
              {/* The budget's arithmetic as what it is: a ledger, totalled at
                  the foot of the column it sums. */}
              <table className="border-collapse text-[0.8rem]">
                <tbody>
                  <tr>
                    <td className="pr-8">income</td>
                    <td className="text-right font-money tabular text-ink">
                      ~{money(r.incomeMean ?? 0)}
                      <span className="text-faint">/mo</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-8">non-housing spending</td>
                    <td className="text-right font-money tabular text-ink">
                      −{money(r.nonHousingMean ?? 0)}
                      <span className="text-faint">/mo</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-8">savings floor (declared)</td>
                    <td className="text-right font-money tabular text-ink">
                      −{money(c.savingsFloor)}
                      <span className="text-faint">/mo</span>
                    </td>
                  </tr>
                  <tr className="border-t border-rule">
                    <td className="pr-8 pt-1">estimated budget</td>
                    <td className="pt-1 text-right font-money tabular font-semibold text-ink">
                      ~{money(r.pitiBudget ?? 0)}
                      <span className="font-normal text-faint">/mo</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p>
                Averaged over your last {r.basisMonths} complete {monthsWord(r.basisMonths)}, one-off pay such as a bonus
                left out of income.
              </p>
            </div>
          </details>
        </>
      )}
      {/* The five typed values collapse behind one disclosure — tap/click on
          any device, hover-preview via title on desktop. The AS-OF DATE stays
          on the summary deliberately: it is the staleness alarm, and a hidden
          rate must never be able to read current forever. When the rate is
          the FETCHED index rather than typed (rateSource set), the summary
          also names the source and series, and as-of is the OBSERVATION date
          — a national average must never be mistakable for a personal quote,
          nor a stalled series for a current one. */}
      <details className="group pt-2.5 text-[0.78rem] text-faint">
        <summary
          className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 max-md:min-h-[44px] max-md:items-center [&::-webkit-details-marker]:hidden"
          title={`${c.ratePct}% / ${c.termYears} yr · property tax ${c.taxPctYr}%/yr · insurance ${c.insurancePctYr}%/yr · PMI ${c.pmiPctYr}%/yr below ${c.downPct}% down · closing ${c.closingPct}% of price${c.rateSource === undefined ? "" : ` · rate observed ${c.asOf} (${c.rateSource.provider} ${c.rateSource.seriesId})`}`}
        >
          <span className={ASSUMED_CHIP}>Assumed</span>
          <span>
            rate{c.rateSource !== undefined && ` (${c.rateSource.provider} ${c.rateSource.seriesId})`}, term, tax, insurance, PMI, closing · as of {c.asOf}
          </span>
          {/* The native marker is hidden and the only preview was a title
              attribute, so nothing at all said the five numbers the whole
              panel leans on were one tap away — least of all on touch, where
              the title does not exist. One glyph, rotated when open. */}
          <span
            aria-hidden="true"
            className="text-[0.7rem] transition-transform group-open:rotate-90"
          >
            ›
          </span>
        </summary>
        <p className="pt-1.5">
          {c.ratePct}% / {c.termYears} yr · property tax {c.taxPctYr}%/yr · insurance{" "}
          {c.insurancePctYr}%/yr · PMI {c.pmiPctYr}%/yr below {c.downPct}% down · closing{" "}
          {c.closingPct}% of price
          {c.rateSource !== undefined &&
            ` · rate from ${c.rateSource.provider} ${c.rateSource.seriesId}, observed ${c.asOf}`}
        </p>
      </details>
    </div>
  );
}

/**
 * The tab's one figure (2026-10-04), the way Overview leads with net worth and
 * every /trends card with its answer: /insights opened on a heading. The
 * figure is where the month's SPENDING lands. For the month being lived in it
 * is the projection, or, while the projection refuses, what is spent so far,
 * and the line under it says which in words; for a closed month, what it came
 * to. It replaces the pace paragraph that sat under the digest, and the
 * context line keeps every fact that paragraph printed, refusals included.
 */
function MonthHeadline({
  pace,
  spent,
  periodLabel,
}: {
  pace: Pace | null;
  spent: { total: number; previous: number | null } | null;
  periodLabel: string;
}) {
  const month = periodLabel.split(" ")[0];
  if (pace !== null) {
    const projected = pace.projected;
    const due = pace.committedRemaining > 0 ? pace.committedRemaining : null;
    return (
      <div>
        <div className={FIELD_LABEL}>Spending</div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-money text-[2.1rem] tabular">
            {projected !== null ? `~${money(projected)}` : money(pace.spentSoFar)}
          </span>
          {projected !== null && <span className={PROJECTED_CHIP}>Projected</span>}
        </div>
        {projected !== null ? (
          <>
            {/* One line in view: what is spent and what a typical rest of the
                month adds, with the one caveat to discount; how it is worked
                out is a tap away. */}
            <p className="mt-1 max-w-[760px] text-[0.78rem] leading-relaxed text-faint">
              <Fig>{money(pace.spentSoFar)}</Fig> spent so far,{" "}
              <Fig>~{money(pace.restIsEveryday ? (pace.typicalRest ?? 0) : Math.max(0, projected - pace.spentSoFar))}</Fig>{" "}
              more in a typical rest of {month}
              {/* Visibly incomplete beats silently wrong: a baseline drawn
                  from before an account existed is understated. */}
              {pace.basisMissingAccounts > 0 && "; may run low, earlier months miss an account"}.
            </p>
            <details className="group max-w-[760px] text-[0.78rem] text-faint">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 max-md:min-h-[44px] [&::-webkit-details-marker]:hidden">
                How this is worked out
                <span aria-hidden="true" className="text-[0.7rem] transition-transform group-open:rotate-90">
                  ›
                </span>
              </summary>
              <p className="pt-1 leading-relaxed">
                Day {pace.dayOfPeriod} of {pace.daysInPeriod}.{" "}
                {pace.restIsEveryday ? (
                  <>
                    The rest of the month is what{" "}
                    {pace.basis === "SAME_MONTH" ? `the last ${pace.basisCount} ${month}s` : `your last ${pace.basisCount} months`}{" "}
                    spent after day {pace.dayOfPeriod}, travel and one-off purchases left out; anything you spend this month
                    counts.
                  </>
                ) : (
                  <>
                    {pace.basis === "SAME_MONTH" ? `A typical ${month} ran ` : "The last few months ran "}
                    <Fig>{money(pace.typical ?? 0)}</Fig>
                    {pace.basis === "SAME_MONTH" ? ` (${pace.basisCount} prior years)` : ""}, and the rest of the month is
                    its share.
                  </>
                )}
                {due !== null && (
                  <>
                    {" "}
                    <Fig>{money(due)}</Fig> of recurring charges is still due, the least the rest can be.
                  </>
                )}
                {pace.basisMissingAccounts > 0 &&
                  ` Those months miss ${pace.basisMissingAccounts === 1 ? "an account" : `${pace.basisMissingAccounts} accounts`} you have now, so their spending reads low.`}
              </p>
            </details>
          </>
        ) : (
          <p className="mt-1 max-w-[760px] text-[0.78rem] leading-relaxed text-faint">
            <Lead>Spent in {month} so far</Lead>, day {pace.dayOfPeriod} of {pace.daysInPeriod}
            {due !== null && (
              <>
                , with <Fig>{money(due)}</Fig> due before month end
              </>
            )}
            .{" "}
            {pace.refusal === "TOO_EARLY"
              ? "Too early in the month to say where it lands."
              : `No comparable month to project from yet: ${pace.basisCount === 0 ? "none" : "too few"} with complete data.`}
          </p>
        )}
      </div>
    );
  }
  if (spent === null) return null;
  return (
    <div>
      <div className={FIELD_LABEL}>Spending</div>
      <div className="font-money text-[2.1rem] tabular">{money(spent.total)}</div>
      <p className="mt-1 text-[0.78rem] leading-relaxed text-faint">
        <Lead>Spent in {periodLabel}</Lead>
        {spent.previous !== null && (
          <>
            , against <Fig>{money(spent.previous)}</Fig> the month before
          </>
        )}
        .
      </p>
    </div>
  );
}

export default async function InsightsPage(props: {
  searchParams: Promise<{ period?: string; show?: string }>;
}) {
  return withDatabaseNotice(() => renderInsights(props));
}

async function renderInsights({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; show?: string }>;
}) {
  const { period, show } = await searchParams;
  const showDismissed = show === "dismissed";
  const data = await getInsightsPageData(period);

  if (data === null) {
    return (
      <p className="py-10 text-faint">
        No insights yet. Run a sync or seed fixture data, then generate insights.
      </p>
    );
  }

  const shown = (title: string) =>
    (data.groups.find((g) => g.title === title)?.rows ?? []).filter((r) => showDismissed || !r.dismissed);
  const anomalies = shown("Anomalies");
  const recurringGroup = data.groups.find((g) => g.title === "Recurring charges");
  const recurring = shown("Recurring charges");
  const recurringNote = recurringGroup?.note ?? null;
  const lapsed = shown("No longer charging");
  // A plan the operator declared by hand that the detector has not seen has
  // no row of its own, only its place in the next 30 days.
  const declared = data.commitments?.items.filter((c) => c.source === "REGISTERED") ?? [];

  return (
    // The Trends scaffold: every section a child of one grid, spaced by the
    // grid rather than by its own mt-4. Sections at 16px apart ran at less than
    // half the rhythm of the tab beside it, so the page read as one long list.
    <div className="grid gap-10 py-5">
      <div>
      <PageTitle>Insights</PageTitle>
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-ink pb-3">
        <span className="flex items-center gap-2 font-money text-[0.85rem]">
          {data.prevPeriod !== null ? (
            <Link href={`/insights?period=${data.prevPeriod}${showDismissed ? "&show=dismissed" : ""}`} className={ARROW}>
              ‹
            </Link>
          ) : (
            <span className={`${ARROW} opacity-30`}>‹</span>
          )}
          <span className="text-ink">{data.periodLabel}</span>
          {data.nextPeriod !== null ? (
            <Link href={`/insights?period=${data.nextPeriod}${showDismissed ? "&show=dismissed" : ""}`} className={ARROW}>
              ›
            </Link>
          ) : (
            <span className={`${ARROW} opacity-30`}>›</span>
          )}
        </span>
        {data.dismissedCount > 0 && (
          <Link
            href={`/insights?period=${data.period}${showDismissed ? "" : "&show=dismissed"}`}
            className="text-[0.78rem] text-faint hover:text-ink"
          >
            {showDismissed
              ? "Hide dismissed"
              : `Show ${data.dismissedCount} dismissed`}
          </Link>
        )}
      </div>

      {/* The admission rule clamps every rowless month except the one being
          lived in, which is right — but it did it in silence, so a bookmarked
          or hand-typed ?period= landed somewhere it never named and the URL
          went on claiming otherwise. */}
      {data.clampedFrom !== null && (
        <p className="pt-3 text-[0.78rem] text-faint">
          <span className="text-ink">{monthLabel(data.clampedFrom)}</span> has no insights; showing{" "}
          {data.periodLabel}.
        </p>
      )}

      <div className="pt-3">
        <CoverageNotice coverage={data.coverage} />
      </div>
      </div>

      {/* THIS MONTH: where spending lands, then what is worth a look. The
          anomalies the digest did not lead with follow it in the same list,
          so the month's findings read as one thing, not two sections. */}
      <section>
        <SectionTitle>{data.isCurrentPeriod ? "This month" : data.periodLabel}</SectionTitle>
        <MonthHeadline pace={data.pace} spent={data.spent} periodLabel={data.periodLabel} />
        <div className="mt-6">
          <SubsectionTitle>Worth your attention</SubsectionTitle>
          {data.digest.map((row, i) => (
            <div
              key={`${row.chip}-${i}`}
              className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-rule py-2 text-[0.85rem] last:border-b-0 max-md:py-3"
            >
              <span className={`${CHIP} ${CHIP_CLASS[row.tone]}`}>{row.chip}</span>
              <span className="min-w-0 flex-1 max-md:basis-full">{row.text}</span>
              <span className="whitespace-nowrap font-money text-[0.78rem] tabular text-faint">{row.consequence}</span>
            </div>
          ))}
          {anomalies.map((row) => (
            <InsightRowView key={row.id} row={row} />
          ))}
          {data.digest.length === 0 && anomalies.length === 0 && (
            <p className="text-[0.85rem] text-faint">
              {data.emptyPeriod
                ? `Nothing recorded for ${data.periodLabel} yet. Spending appears with the month's first sync.`
                : data.coverage?.hasUnknownShortfall === true
                  ? `Nothing to report for ${data.periodLabel}. The notice above says why this month cannot be judged.`
                  : `Nothing needs your attention in ${data.periodLabel}.`}
            </p>
          )}
        </div>
      </section>

      {/* GOALS: every declared target in one place. The net worth goal leads,
          the long view; house readiness rides directly under the goal that
          funds it. */}
      {(data.netWorthGoal !== null || data.goals.length > 0) && (
        <section>
          <SectionTitle>Goals</SectionTitle>
          {data.netWorthGoal !== null && (
            <div className="border-b border-rule pb-4">
              <NetWorthGoalPanel g={data.netWorthGoal} />
            </div>
          )}
          {data.goals.map((g, i) => (
            <div key={g.goal.id} className="border-b border-rule py-4 last:border-b-0">
              <SavingsGoalCard g={g} history={data.goalHistory[g.goal.id] ?? []} anchor={data.period} />
              {i === 0 && data.readiness !== null && (
                <div className="mt-4 border-l-2 border-rule pl-3">
                  <SubsectionTitle>House readiness</SubsectionTitle>
                  <ReadinessBlock
                    r={data.readiness}
                    fundName={g.goal.name}
                    targetHousePrice={g.goal.housePrice ?? null}
                    depositLands={g.reached ? null : g.landsMonth}
                  />
                </div>
              )}
            </div>
          ))}
          {data.goals.filter((g) => g.landsMonth !== null).length >= 2 && (
            <p className="pt-1.5 text-[0.72rem] text-faint">
              Each savings date assumes the full savings rate goes to that goal.
            </p>
          )}
        </section>
      )}

      {/* RECURRING: one list. Each live plan carries its next charge, the
          next 30 days are totalled at the top, and plans that stopped fold
          away at the foot. Three sections said this before. */}
      {(recurring.length > 0 || lapsed.length > 0 || declared.length > 0) && (
        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <SectionTitle>Recurring charges</SectionTitle>
            {recurringNote !== null && (
              <span className="font-money text-[0.75rem] tabular text-faint">{recurringNote}</span>
            )}
          </div>
          {data.commitments !== null && (
            <p className="flex flex-wrap items-baseline gap-x-2 pb-1 text-[0.85rem]">
              <span className="text-faint">Due in the next {data.commitments.windowDays} days</span>
              <span className="font-money font-semibold tabular">{money(data.commitments.total)}</span>
              <span className={PROJECTED_CHIP}>Projected</span>
            </p>
          )}
          {recurring.map((row) => (
            <InsightRowView key={row.id} row={row} />
          ))}
          {declared.map((c) => (
            <div
              key={`${c.merchant}-${c.dueDate.toISOString()}`}
              className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-rule py-2 text-[0.85rem] last:border-b-0 max-md:py-3"
            >
              <span className="min-w-0 flex-1">
                {titleCase(c.merchant)}{" "}
                <span className={`${CHIP} border border-rule text-faint`}>declared</span>
              </span>
              <NextCharge next={{ date: c.dueDate, daysAway: c.daysAway, amount: c.amount }} />
            </div>
          ))}
          {lapsed.length > 0 && (
            <details className="group pt-2 text-[0.85rem]">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[0.78rem] text-faint max-md:min-h-[44px] [&::-webkit-details-marker]:hidden">
                No longer charging ({lapsed.length})
                <span aria-hidden="true" className="text-[0.7rem] transition-transform group-open:rotate-90">
                  ›
                </span>
              </summary>
              {lapsed.map((row) => (
                <InsightRowView key={row.id} row={row} />
              ))}
            </details>
          )}
        </section>
      )}

      {/* Trips & projects with rows in the month on screen — FACTS, no chips:
          every figure is the plain signed sum of tagged rows the link opens,
          so there is nothing projected or assumed to flag. Absent entirely
          when no group touches the period: a trip is opt-in content like
          goals, and an empty heading would imply the engine went looking. */}
      {data.trips.length > 0 && (
        <section>
          <SectionTitle>Trips &amp; projects</SectionTitle>
          {data.trips.map((t) => (
            <div
              key={t.label}
              className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-rule py-2 text-[0.85rem] last:border-b-0 max-md:py-3"
            >
              <Link href={t.href} className="tap44 font-semibold text-acc hover:underline">
                {t.label}
              </Link>
              <span className="font-money text-[0.72rem] tabular text-faint">
                {shortDate(t.firstDate)} – {shortDate(t.lastDate)}
              </span>
              <span className="min-w-0">
                {data.periodLabel}: <span className="font-money tabular">{money(t.periodNet)}</span>
                <span className="text-faint">
                  {" "}
                  ({t.periodRowCount} row{t.periodRowCount === 1 ? "" : "s"})
                </span>
              </span>
              <span className="ml-auto whitespace-nowrap font-money text-[0.78rem] tabular text-faint">
                {(t.runningNet !== t.periodNet || t.rowCount !== t.periodRowCount) && (
                  <>
                    running {money(t.runningNet)} · {t.rowCount} row{t.rowCount === 1 ? "" : "s"}
                  </>
                )}
                {t.transferCount > 0 &&
                  `${t.runningNet !== t.periodNet || t.rowCount !== t.periodRowCount ? " · " : ""}${t.transferCount} transfer${t.transferCount === 1 ? "" : "s"}`}
              </span>
            </div>
          ))}
          <p className="pt-1.5 text-[0.72rem] text-faint">
            The signed net of each trip&apos;s tagged rows, exactly as its ledger lists them. Transfers ride along
            when tagged, and spending analytics still exclude them.
          </p>
        </section>
      )}

      {/* What used to close the page, one row a month each for net worth,
          cash flow and spending, is drawn properly on Trends. */}
      <p className="border-t border-rule pt-3 text-[0.78rem] text-faint">
        Net worth, cash flow and spending, month by month:{" "}
        <Link href="/trends" className="tap44 text-acc hover:underline">
          Trends
        </Link>
      </p>
    </div>
  );
}
