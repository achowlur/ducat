import Link from "next/link";
import { CoverageNotice } from "../../components/CoverageNotice";
import { DismissButton } from "../../components/DismissButton";
import { getInsightsPageData, type InsightRow } from "../../lib/ui/insights";
import { GOAL_RATE_MIN_MONTHS, type GoalAssessment } from "../../lib/insights/goals";
import { money, monthLabel, shortDate, titleCase } from "../../lib/ui/format";

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
const PROJECTED_CHIP =
  "whitespace-nowrap rounded-[2px] bg-chip px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-acc";

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
      <p className="pt-1 leading-relaxed text-faint">
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
          <>
            Saving <span className="font-money tabular text-ink">~{money(g.monthlyRate ?? 0)}</span>/mo
            over your last {g.basisMonths} complete months (lowest{" "}
            <span className="font-money tabular">{money(g.rateLow ?? 0)}</span>, highest{" "}
            <span className="font-money tabular">{money(g.rateHigh ?? 0)}</span>) —{" "}
            <span className={PROJECTED_CHIP}>Projected</span>{" "}
            {(g.monthsToTarget ?? 0) > 600 ? (
              // deltaMonths still decides ahead/behind out here — a far-future
              // aspiration can sit BEYOND a 50-year landing, and asserting
              // "behind" against it would be false.
              g.deltaMonths === null
                ? "lands more than 50 years out at this rate."
                : g.deltaMonths > 0
                  ? "lands more than 50 years out at this rate — far behind target."
                  : "lands more than 50 years out at this rate — and still not past the declared month."
            ) : (
              <>
                lands <span className="font-semibold text-ink">~{monthLabel(g.landsMonth ?? "")}</span>
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
            {g.observedFundGrowth !== null && (
              <>
                {" "}Cash itself grew{" "}
                <span className="font-money tabular">~{money(g.observedFundGrowth)}</span>/mo over the
                same window — the landing assumes the full rate reaches it.
              </>
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
      </p>
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

      <div className="pt-3">
        <CoverageNotice coverage={data.coverage} />
      </div>

      {/* The lead: a few things ranked by what they cost over a year, rather
          than five streams grouped by insight type with equal weight. The
          stake is shown because it IS the running order — a reader who
          disagrees with the ranking can see what it was based on. */}
      {data.digest.length > 0 ? (
        <section className="mt-4">
          <h3 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
            Worth your attention
          </h3>
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
              <span className="min-w-0 flex-1">{row.text}</span>
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
            <h3 className="text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
              Already committed — next {data.commitments.windowDays} days
            </h3>
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
          <h3 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
            Savings goals
          </h3>
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

      {/* Suppressed for the empty current month: the line above already says
          why there is nothing, and two quiet lines saying it reads broken. */}
      {visibleGroups.length === 0 && !data.emptyPeriod && (
        <p className="py-6 text-[0.85rem] text-faint">Nothing to show for {data.periodLabel}.</p>
      )}

      {visibleGroups.map((group) => (
        <section key={group.title} className="pt-5">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h3 className="text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
              {group.title}
            </h3>
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
