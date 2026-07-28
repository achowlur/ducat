import Link from "next/link";
import { CoverageNotice } from "../../components/CoverageNotice";
import { DismissButton } from "../../components/DismissButton";
import { getInsightsPageData, type InsightRow } from "../../lib/ui/insights";
import { money, shortDate, titleCase } from "../../lib/ui/format";

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
                <span className="whitespace-nowrap rounded-[2px] bg-chip px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-acc">
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
            <span className="whitespace-nowrap rounded-[2px] bg-chip px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-acc">
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

      {visibleGroups.length === 0 && (
        <p className="py-6 text-[0.85rem] text-faint">Nothing to show for {data.periodLabel}.</p>
      )}

      {visibleGroups.map((group) => (
        <section key={group.title} className="pt-5">
          <h3 className="mb-2 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
            {group.title}
          </h3>
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
