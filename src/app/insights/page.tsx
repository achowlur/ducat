import Link from "next/link";
import { CoverageNotice } from "../../components/CoverageNotice";
import { DismissButton } from "../../components/DismissButton";
import { getInsightsPageData, type InsightRow } from "../../lib/ui/insights";
import { GOAL_RATE_MIN_MONTHS, type GoalAssessment } from "../../lib/insights/goals";
import { type ReadinessAssessment } from "../../lib/insights/readiness";
import { money, monthLabel, shortDate, titleCase } from "../../lib/ui/format";
import { PageTitle } from "../../components/ui/headings";

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

/**
 * One definition for the chip every forecast on this page wears. Three panels
 * carry it now (pace, commitments, goals), and the moment a forecast reads
 * like an observation the app is asserting what it does not know.
 */
// inline-block, so the box survives an inline parent: the same class string
// measured 76.1 × 19.8 inside a flex row and 76.1 × 14.0 inside a bare <p>,
// i.e. one chip at two heights on one page.
const PROJECTED_CHIP =
  "inline-block whitespace-nowrap rounded-[2px] bg-chip px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-acc";

/**
 * The ASSUMED variant of the same chip family: for numbers the operator TYPED
 * (the readiness panel's rate, term, tax, insurance, PMI, closing) rather than
 * numbers projected from observation. Outlined where PROJECTED is filled, so
 * the two claims stay distinguishable at a glance — a typed rate is a weaker
 * claim than an observed cadence, and it should not wear the stronger chip.
 */
const ASSUMED_CHIP =
  "inline-block whitespace-nowrap rounded-[2px] border border-rule px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-faint";

/**
 * One declared goal against the observed savings rate. Every refusal renders
 * rather than hides, and the facts either side of the projection — saved,
 * target, the rate itself — survive all of them.
 */
function GoalRow({ g }: { g: GoalAssessment }) {
  const monthsWord = (n: number) => (n === 1 ? "month" : "months");
  return (
    <div className="border-b border-rule py-2.5 text-[0.85rem] last:border-b-0 max-md:py-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="font-semibold">{g.goal.name}</span>
        <span className="font-money tabular">
          <span className="font-semibold">{money(g.saved)}</span>
          <span className="text-faint"> of {money(g.goal.target)}</span>
        </span>
        <span className="text-faint">
          {Math.floor(g.progress * 100)}%
          {g.goal.targetMonth === undefined ? "" : ` · by ${monthLabel(g.goal.targetMonth)}`}
        </span>
        {g.accountNames.length > 0 && (
          <span className="ml-auto font-money text-[0.72rem] text-faint">
            {g.accountNames.join(" + ")}
          </span>
        )}
      </div>
      {/* Progress as FORM, not only figure — the % is scannable without
          reading; honest width, no minimum, so 1% looks like 1%. */}
      <div className="mt-1.5 h-[3px] w-full rounded-[1px] bg-chip">
        <div
          className={`h-full rounded-[1px] ${g.reached ? "bg-pos" : "bg-acc"}`}
          // Floor, matching the printed % beside it — a bar one point wider
          // than its own figure is the two-totals bug class in miniature.
          style={{ width: `${Math.min(100, Math.floor(g.progress * 100))}%` }}
        />
      </div>
      <div className="pt-1 leading-relaxed text-faint">
        {g.reached ? (
          <>
            <span
              className={`whitespace-nowrap rounded-[2px] px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] ${CHIP_CLASS.pos}`}
            >
              Reached
            </span>{" "}
            <span className="font-money tabular text-ink">{money(g.saved)}</span> against the{" "}
            <span className="font-money tabular">{money(g.goal.target)}</span> target.
          </>
        ) : g.refusal === "NO_ACCOUNTS" ? (
          g.goal.cash === true ? (
            <>
              Nothing counts as cash right now — declare cash accounts with{" "}
              <span className="font-money">npm run accounts:cash</span>.
            </>
          ) : (
            <>
              None of the accounts this goal nominates exist any more — re-point it with{" "}
              <span className="font-money">npm run goals</span>.
            </>
          )
        ) : g.refusal === "TOO_FEW_MONTHS" ? (
          g.basisMonths === 0 ? (
            "No complete months of cash-flow history yet — nothing to project a landing date from."
          ) : (
            `Only ${g.basisMonths} complete ${monthsWord(g.basisMonths)} of cash-flow history — too few to project a landing date (${GOAL_RATE_MIN_MONTHS} needed).`
          )
        ) : g.refusal === "RATE_NOT_POSITIVE" ? (
          <>
            Averaged over your last {g.basisMonths} complete months you are not saving (
            <span className="font-money tabular">{money(g.monthlyRate ?? 0)}</span>/mo net), so there is
            no landing date worth printing.
          </>
        ) : (
          // The landing is the DECISION line and leads; the rate that produced
          // it and the reconciliation each get their own quiet line below —
          // same facts as before, ranked instead of run together.
          <>
            <p>
              <span className={PROJECTED_CHIP}>Projected</span>{" "}
              <span className="text-ink">
                {(g.monthsToTarget ?? 0) > 600 ? (
                  // deltaMonths still decides ahead/behind out here — a
                  // far-future aspiration can sit BEYOND a 50-year landing,
                  // and asserting "behind" against it would be false.
                  g.deltaMonths === null
                    ? "lands more than 50 years out at this rate."
                    : g.deltaMonths > 0
                      ? "lands more than 50 years out at this rate — far behind target."
                      : "lands more than 50 years out at this rate — and still not past the declared month."
                ) : (
                  <>
                    lands <span className="font-semibold">~{monthLabel(g.landsMonth ?? "")}</span>
                    {g.deltaMonths === null ? (
                      "."
                    ) : (
                      <>
                        {" — "}
                        {g.deltaMonths === 0
                          ? "on target."
                          : g.deltaMonths < 0
                            ? `${-g.deltaMonths} ${monthsWord(-g.deltaMonths)} ahead of target.`
                            : `${g.deltaMonths} ${monthsWord(g.deltaMonths)} behind target.`}
                      </>
                    )}
                  </>
                )}
              </span>
            </p>
            <p className="pt-0.5">
              Saving <span className="font-money tabular text-ink">~{money(g.monthlyRate ?? 0)}</span>
              /mo over your last {g.basisMonths} complete months
            </p>
            {g.observedFundGrowth !== null && (
              <p className="pt-0.5">
                Cash itself grew{" "}
                <span className="font-money tabular">~{money(g.observedFundGrowth)}</span>/mo over the
                same window — the landing assumes the full rate reaches it.
              </p>
            )}
          </>
        )}
        {g.missingAccounts > 0 && g.refusal !== "NO_ACCOUNTS" && (
          <span className="text-neg">
            {" "}
            {g.missingAccounts} nominated {g.missingAccounts === 1 ? "account" : "accounts"} no longer{" "}
            {g.missingAccounts === 1 ? "exists" : "exist"} — saved is understated.
          </span>
        )}
      </div>
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
function ReadinessBlock({
  r,
  fundName,
  targetHousePrice,
}: {
  r: ReadinessAssessment;
  fundName: string | null;
  targetHousePrice: number | null;
}) {
  const c = r.config;
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
            : `Only ${r.basisMonths} complete ${monthsWord(r.basisMonths)} of history`}{" "}
          — too few to average income and non-housing spending ({GOAL_RATE_MIN_MONTHS} needed). What
          stands regardless: {fundCaps}.
        </p>
      ) : r.refusal === "FLOOR_EXCEEDS_RESIDUAL" ? (
        <p className="leading-relaxed text-faint">
          Income <Money n={r.incomeMean ?? 0} about />
          /mo minus non-housing spending <Money n={r.nonHousingMean ?? 0} about />
          /mo, over your last {r.basisMonths} complete {monthsWord(r.basisMonths)}, leaves no mortgage
          budget once the <Money n={c.savingsFloor} />
          /mo savings floor you declared is kept — it comes to{" "}
          <span className="font-money tabular text-ink">{money(r.pitiBudget ?? 0)}</span>/mo, so the
          floor is the reason there is no payment ceiling. What stands regardless: {fundCaps}.
        </p>
      ) : (
        <>
          {/* HEADLINE → DETAIL, Overview's shape, with no prose in between:
              every figure the two removed sentences carried is either a band
              cell or a ledger row — same facts, now in the forms a scanner
              reads. The fund detail rides its cell as a sub-caption. */}
          <div className="flex flex-wrap gap-x-9 gap-y-2.5">
            <div>
              <div className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-faint">
                Estimated budget
              </div>
              <div className="font-money tabular text-[1.05rem] font-semibold">
                ~{money(r.pitiBudget ?? 0)}
                <span className="text-[0.8rem] font-normal text-faint">/mo</span>
              </div>
            </div>
            <div>
              <div className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-faint">
                Ceiling today — {r.bindingConstraint === "FUND" ? "fund-limited" : "payment-limited"}
              </div>
              <div className="font-money tabular text-[1.05rem] font-semibold">
                ~
                {money(
                  r.bindingConstraint === "FUND" ? r.fundLimitedPrice : (r.paymentLimitedPrice ?? 0),
                )}
              </div>
              <div className="pt-0.5 text-[0.72rem] text-faint">
                {r.bindingConstraint === "FUND"
                  ? `${money(r.fund)} ${fundName === null ? "fund" : fundName} · ${c.downPct}% down + ${c.closingPct}% closing`
                  : "at the estimated budget"}
              </div>
            </div>
            <div>
              <div className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-faint">
                {r.bindingConstraint === "FUND" ? "Payment could carry" : "Fund caps at"}
              </div>
              <div className="font-money tabular text-[1.05rem]">
                ~
                {money(
                  r.bindingConstraint === "FUND" ? (r.paymentLimitedPrice ?? 0) : r.fundLimitedPrice,
                )}
              </div>
              <div className="pt-0.5 text-[0.72rem] text-faint">
                {r.bindingConstraint === "FUND"
                  ? "at the estimated budget"
                  : `${money(r.fund)} ${fundName === null ? "fund" : fundName} · ${c.downPct}% down + ${c.closingPct}% closing`}
              </div>
            </div>
            {r.balancedPrice !== null && r.cashNeededAtBalance !== null && (
              <div>
                <div className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-faint">
                  Balanced target
                </div>
                <div className="font-money tabular text-[1.05rem]">
                  ~{money(r.balancedPrice)}
                </div>
                <div className="pt-0.5 text-[0.72rem] text-faint">
                  with ~{money(r.cashNeededAtBalance)} cash
                </div>
              </div>
            )}
            {targetHousePrice !== null && (
              <div>
                <div className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-faint">
                  Target house
                </div>
                <div className="font-money tabular text-[1.05rem]">{money(targetHousePrice)}</div>
                <div className="pt-0.5 text-[0.72rem] text-faint">
                  needs ~{money((targetHousePrice * (c.downPct + c.closingPct)) / 100)} cash at{" "}
                  {c.downPct}% down + {c.closingPct}% closing
                </div>
              </div>
            )}
          </div>
          {/* The budget's arithmetic as what it is — a ledger, totalled at the
              foot of the column it sums. */}
          <div className="mt-2.5 inline-block">
            <table className="border-collapse text-[0.8rem]">
              <tbody>
                <tr>
                  <td className="pr-8 text-faint">income</td>
                  <td className="text-right font-money tabular">
                    ~{money(r.incomeMean ?? 0)}
                    <span className="text-faint">/mo</span>
                  </td>
                </tr>
                <tr>
                  <td className="pr-8 text-faint">non-housing spending</td>
                  <td className="text-right font-money tabular">
                    −{money(r.nonHousingMean ?? 0)}
                    <span className="text-faint">/mo</span>
                  </td>
                </tr>
                <tr>
                  <td className="pr-8 text-faint">savings floor (declared)</td>
                  <td className="text-right font-money tabular">
                    −{money(c.savingsFloor)}
                    <span className="text-faint">/mo</span>
                  </td>
                </tr>
                <tr className="border-t border-rule">
                  <td className="pr-8 pt-1 text-faint">estimated budget</td>
                  <td className="pt-1 text-right font-money tabular font-semibold">
                    ~{money(r.pitiBudget ?? 0)}
                    <span className="font-normal text-faint">/mo</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="pt-1 text-[0.72rem] text-faint">
              averaged over your last {r.basisMonths} complete {monthsWord(r.basisMonths)}
            </p>
          </div>
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

export default async function InsightsPage({
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

  const visibleGroups = data.groups
    .map((g) => ({ ...g, rows: showDismissed ? g.rows : g.rows.filter((r) => !r.dismissed) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="py-5">
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
          <span className="text-ink">{monthLabel(data.clampedFrom)}</span> has no insights — showing{" "}
          {data.periodLabel}.
        </p>
      )}

      <div className="pt-3">
        <CoverageNotice coverage={data.coverage} />
      </div>

      {/* The lead: a few things ranked by what they cost over a year, rather
          than five streams grouped by insight type with equal weight. The
          stake is shown because it IS the running order — a reader who
          disagrees with the ranking can see what it was based on. */}
      {data.digest.length > 0 ? (
        <section className="mt-4">
          <h2 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
            Worth your attention
          </h2>
          {data.digest.map((row, i) => (
            <div
              key={`${row.chip}-${i}`}
              className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-rule py-2 text-[0.85rem] last:border-b-0 max-md:py-3"
            >
              <span
                className={`whitespace-nowrap rounded-[2px] px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] ${CHIP_CLASS[row.tone]}`}
              >
                {row.chip}
              </span>
              {/* `flex-1 min-w-0` beside a `whitespace-nowrap` consequence let
                  the SENTENCE take all the shrinkage: at 375px the row's text
                  got a 44.1px column and stacked seven lines tall, three
                  characters wide, so the page's lead — the thing it opens with
                  — was the least readable block on it. Below md the sentence
                  takes its own line and the consequence follows, which is the
                  same treatment the dismiss button and the period arrows
                  already got. */}
              <span className="min-w-0 flex-1 max-md:basis-full">{row.text}</span>
              <span className="whitespace-nowrap font-money text-[0.78rem] tabular text-faint">
                {row.consequence}
              </span>
            </div>
          ))}
        </section>
      ) : data.emptyPeriod ? (
        /* A month nothing has synced into yet — reachable so the forward
           panels below can render on day 1. "Nothing needs your attention"
           would claim the engine looked, and it has not: all clear cannot be
           told from not checked if the difference is never stated. */
        <p className="mt-4 text-[0.85rem] text-faint">
          Nothing recorded for {data.periodLabel} yet — spending appears with the month&apos;s first
          sync.
        </p>
      ) : data.coverage?.hasUnknownShortfall === true ? (
        /* Same epistemic state as the empty month, reached by a different
           route: an account with NO data for the period means the engine could
           not look, so "nothing needs your attention" is the stronger claim it
           has not earned — and it was printing 16px under an amber notice
           saying 0 of 21 accounts reach this month, which is the contradiction
           stated outright. Only the NO_DATA case; a mid-period start is
           complete data and keeps the ordinary line. */
        <p className="mt-4 text-[0.85rem] text-faint">
          Nothing to report for {data.periodLabel} — the notice above says why this month cannot be
          judged.
        </p>
      ) : (
        /* Saying so is the point, not an empty state to be hidden: most months
           should be quiet, and a digest that always finds four things is one
           nobody will read by March. */
        <p className="mt-4 text-[0.85rem] text-faint">
          Nothing needs your attention in {data.periodLabel}.
        </p>
      )}

      {/* Where the month lands. The refusals render rather than hide: "too
          early to call" is a more useful thing to read than a missing box, and
          the facts either side of the projection survive it. */}
      {data.pace !== null && (
        <section className="mt-4 border-b border-ink pb-3">
          <p className="text-[0.95rem] leading-relaxed">
            <span className="font-money tabular text-faint">
              Day {data.pace.dayOfPeriod} of {data.pace.daysInPeriod}.
            </span>{" "}
            <span className="font-money tabular font-semibold">{money(data.pace.spentSoFar)}</span> spent
            {data.pace.committedRemaining > 0 && (
              <>
                {", "}
                <span className="font-money tabular">{money(data.pace.committedRemaining)}</span> due before
                month end
              </>
            )}
            .{" "}
            {data.pace.refusal === "TOO_EARLY" ? (
              <span className="text-faint">Too early in the month to say where it lands.</span>
            ) : data.pace.refusal === "NO_BASELINE" ? (
              <span className="text-faint">
                No comparable month to project from yet — {data.pace.basisCount === 0 ? "none" : "too few"} with
                complete data.
              </span>
            ) : (
              <>
                <span className="text-faint">
                  {data.pace.basis === "SAME_MONTH"
                    ? `A typical ${data.periodLabel.split(" ")[0]} ran `
                    : "The last few months ran "}
                  <span className="font-money tabular">{money(data.pace.typical ?? 0)}</span>
                  {data.pace.basis === "SAME_MONTH" ? ` (${data.pace.basisCount} prior years)` : ""}
                  {/* Visibly incomplete beats silently wrong: a baseline drawn
                      from before an account existed is understated, so the
                      projection leans low and says so. */}
                  {data.pace.basisMissingAccounts > 0 &&
                    `, before ${data.pace.basisMissingAccounts} of your accounts existed — so this leans low`}
                  {" — "}
                </span>
                <span className={PROJECTED_CHIP}>
                  Projected
                </span>{" "}
                <span className="font-money tabular font-semibold">
                  ~{money(data.pace.projected ?? 0)}
                </span>{" "}
                <span className="text-faint">if the rest of the month is ordinary.</span>
              </>
            )}
          </p>
        </section>
      )}

      {/* The only forward-looking figure in the app, and the only thing on this
          tab that appears nowhere else. Chipped "projected" because a forecast
          that reads like an observation is the app asserting what it does not
          know — cadence and amount are observed, the charge itself has not
          happened. */}
      {data.commitments !== null && (
        <section className="mt-4 border-l-2 border-acc bg-chip px-3 py-2.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={PROJECTED_CHIP}>
              Projected
            </span>
            <h2 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
              Already committed — next {data.commitments.windowDays} days
            </h2>
            <span className="ml-auto font-money text-[0.95rem] font-semibold tabular">
              {money(data.commitments.total)}
            </span>
          </div>

          {data.commitments.items.length === 0 ? (
            <p className="pt-1.5 text-[0.85rem] text-faint">
              Nothing recurring falls due in the next {data.commitments.windowDays} days.
            </p>
          ) : (
            <ul className="grid gap-1 pt-2">
              {data.commitments.items.map((c) => (
                <li
                  key={`${c.merchant}-${c.dueDate.toISOString()}`}
                  className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-3 text-[0.85rem] max-md:py-1"
                >
                  <span className="truncate">
                    {titleCase(c.merchant)}
                    {c.priceIncreased && (
                      <span className="ml-1.5 text-[0.66rem] uppercase tracking-[0.06em] text-neg">
                        price up
                      </span>
                    )}
                    {/* The section's claim is that cadence and amount are both
                        observed. For one you registered by hand they are what
                        you said they were, so it says which. */}
                    {c.source === "REGISTERED" && (
                      <span className="ml-1.5 text-[0.66rem] uppercase tracking-[0.06em] text-faint">
                        declared
                      </span>
                    )}
                  </span>
                  <span className="whitespace-nowrap font-money text-[0.72rem] text-faint">
                    {c.daysAway === 0 ? "today" : `in ${c.daysAway}d`} · {shortDate(c.dueDate)}
                  </span>
                  <span className="text-right font-money tabular">{money(c.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Declared targets against the observed savings rate. Gated to the
          month being lived in like the two projections above — saved and the
          rate are measured from now, so under a historical heading the panel
          would lie. The rate is the app-wide CASH_FLOW_TREND net rather than
          the fund's own growth: transfers are excluded from cash flow, so
          moving money into a nominated account cannot inflate the rate that
          projects it. Absent entirely when no goal is declared — opt-in
          config, not a health question every instance has. */}
      {data.goals.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
            Savings goals
          </h2>
          {data.goals.map((g) => (
            <GoalRow key={g.goal.id} g={g} />
          ))}
          {/* Two dates from one rate are each honest alone and optimistic
              together; the assumption gets said once, not hidden. */}
          {data.goals.filter((g) => g.landsMonth !== null).length >= 2 && (
            <p className="pt-1.5 text-[0.72rem] text-faint">
              Each date assumes the full savings rate goes to that goal.
            </p>
          )}
        </section>
      )}

      {/* House readiness — "am I close enough to start looking?". Gated like
          goals: the month being lived in only, absent entirely without the
          declared config (readiness.house) and a declared goal to be the
          fund. A readiness signal, not lender math: no approval claims live
          here, deliberately. */}
      {data.readiness !== null && (
        <section className="mt-4">
          <h2 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
            House readiness
          </h2>
          <ReadinessBlock
            r={data.readiness}
            fundName={data.goals.length > 0 ? data.goals[0].goal.name : null}
            targetHousePrice={data.goals.length > 0 ? (data.goals[0].goal.housePrice ?? null) : null}
          />
        </section>
      )}

      {/* Trips & projects with rows in the month on screen — FACTS, no chips:
          every figure is the plain signed sum of tagged rows the link opens,
          so there is nothing projected or assumed to flag. Absent entirely
          when no group touches the period: a trip is opt-in content like
          goals, and an empty heading would imply the engine went looking. */}
      {data.trips.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
            Trips &amp; projects
          </h2>
          {data.trips.map((t) => (
            <div
              key={t.label}
              className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-rule py-2 text-[0.85rem] last:border-b-0 max-md:py-3"
            >
              {/* Missed by the 44px sweep: measured 43.4 × 20.4 at 375px, the
                  only control on this page still under the bar. */}
              <Link href={t.href} className="tap44 font-semibold text-acc hover:underline">
                {t.label}
              </Link>
              <span className="font-money text-[0.72rem] tabular text-faint">
                {shortDate(t.firstDate)} – {shortDate(t.lastDate)}
              </span>
              <span className="min-w-0">
                {data.periodLabel}:{" "}
                <span className="font-money tabular">{money(t.periodNet)}</span>
                <span className="text-faint">
                  {" "}
                  ({t.periodRowCount} row{t.periodRowCount === 1 ? "" : "s"})
                </span>
              </span>
              {/* The running total is only worth printing when it DIFFERS from
                  the period's. A trip that fits inside the month on screen
                  produced "July 2026: −$667.03 (2 rows)" and "running −$667.03
                  · 2 rows" on the same line — one figure twice, in two
                  formats. The transfer count is a separate fact and survives
                  either way. */}
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
            The signed net of each trip&apos;s tagged rows, exactly as its ledger lists them —
            transfers ride along when tagged, and spending analytics still exclude them.
          </p>
        </section>
      )}

      {/* Suppressed for the empty current month: the line above already says
          why there is nothing, and two quiet lines saying it reads broken. */}
      {visibleGroups.length === 0 && !data.emptyPeriod && (
        <p className="py-6 text-[0.85rem] text-faint">Nothing to show for {data.periodLabel}.</p>
      )}

      {visibleGroups.map((group) => (
        <section key={group.title} className="pt-5">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
              {group.title}
            </h2>
            {group.note !== null && (
              <span className="font-money text-[0.75rem] tabular text-faint">{group.note}</span>
            )}
          </div>
          {group.rows.map((row) => (
            <div
              key={row.id}
              className={`flex items-start gap-2.5 border-b border-rule py-2 text-[0.85rem] last:border-b-0 max-md:py-3 ${
                row.dismissed ? "opacity-50" : ""
              }`}
            >
              <span
                className={`mt-0.5 whitespace-nowrap rounded-[2px] px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] ${CHIP_CLASS[row.tone]}`}
              >
                {row.chip}
              </span>
              <span className="flex-1">{row.text}</span>
              <DismissButton insightId={row.id} dismissed={row.dismissed} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
