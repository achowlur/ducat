import Link from "next/link";
import { CoverageNotice } from "../../components/CoverageNotice";
import { DismissButton } from "../../components/DismissButton";
import { getPeriodCoverage } from "../../lib/ui/coverage";
import { getInsightsPageData, type InsightRow } from "../../lib/ui/insights";

export const dynamic = "force-dynamic";

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
            <Link href={`/insights?period=${data.prevPeriod}${showDismissed ? "&show=dismissed" : ""}`} className="px-1 text-faint hover:text-ink">
              ‹
            </Link>
          ) : (
            <span className="px-1 text-faint opacity-30">‹</span>
          )}
          <span className="text-ink">{data.periodLabel}</span>
          {data.nextPeriod !== null ? (
            <Link href={`/insights?period=${data.nextPeriod}${showDismissed ? "&show=dismissed" : ""}`} className="px-1 text-faint hover:text-ink">
              ›
            </Link>
          ) : (
            <span className="px-1 text-faint opacity-30">›</span>
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
        <CoverageNotice coverage={await getPeriodCoverage(data.period)} />
      </div>

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
              className={`flex items-start gap-2.5 border-b border-rule py-2 text-[0.85rem] last:border-b-0 ${
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
