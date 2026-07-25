import Link from "next/link";
import { CashFlowChart } from "../../components/charts/CashFlowChart";
import { NetWorthChart } from "../../components/charts/NetWorthChart";
import { TrendsDonut } from "../../components/charts/TrendsDonut";
import { CoverageNotice } from "../../components/CoverageNotice";
import { amount, pct } from "../../lib/ui/format";
import { getPeriodCoverage } from "../../lib/ui/coverage";
import { getTrendsData } from "../../lib/ui/trends";

export const dynamic = "force-dynamic";

const DONUT_COLORS = ["bg-chart1", "bg-chart2", "bg-pie3", "bg-pie4"];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h3>
  );
}

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period } = await searchParams;
  const data = await getTrendsData(period);

  if (data === null) {
    return (
      <p className="py-10 text-faint">
        No insights to chart yet. Run a sync or seed fixture data, then generate insights.
      </p>
    );
  }

  const coverage = await getPeriodCoverage(data.period);

  return (
    <div className="grid gap-9 py-5">
      <CoverageNotice coverage={coverage} />
      <div className="grid gap-9 lg:grid-cols-2">
        <section>
          <div className="flex items-baseline justify-between">
            <SectionTitle>Spending by category</SectionTitle>
            <span className="flex items-center gap-2 font-money text-[0.78rem] text-faint">
              {data.prevPeriod !== null ? (
                <Link href={`/trends?period=${data.prevPeriod}`} className="px-1 hover:text-ink">
                  ‹
                </Link>
              ) : (
                <span className="px-1 opacity-30">‹</span>
              )}
              <span className="text-ink">{data.periodLabel}</span>
              {data.nextPeriod !== null ? (
                <Link href={`/trends?period=${data.nextPeriod}`} className="px-1 hover:text-ink">
                  ›
                </Link>
              ) : (
                <span className="px-1 opacity-30">›</span>
              )}
            </span>
          </div>
          <p className="mb-3 text-[0.75rem] text-faint">
            Transfers excluded. Hover for detail; click a slice or row to open those transactions.
          </p>
          {data.donut === null ? (
            <p className="text-[0.85rem] text-faint">No spending recorded in {data.periodLabel}.</p>
          ) : (
            <div className="flex flex-wrap items-start gap-6">
              <TrendsDonut slices={data.donut.slices} total={data.donut.total} period={data.period} />
              <table className="min-w-[260px] flex-1 border-collapse">
                <thead>
                  <tr className="border-b border-ink">
                    <th className="py-1 text-left text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                      Category
                    </th>
                    <th className="py-1 text-right text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                      Spent
                    </th>
                    <th className="py-1 text-right text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                      vs prev
                    </th>
                    <th className="py-1 text-right text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.categories.map((c, i) => (
                    <tr key={`${c.categoryId}-${c.label}`} className="border-b border-rule last:border-b-0">
                      <td className="py-1.5 text-[0.85rem]">
                        <Link
                          href={`/transactions?period=${data.period}&category=${c.categoryId ?? "uncategorized"}`}
                          className="hover:underline"
                        >
                          {i < 3 && (
                            <i className={`mr-2 inline-block h-[10px] w-[10px] rounded-[2px] align-[-1px] ${DONUT_COLORS[i]}`} />
                          )}
                          {i >= 3 && (
                            <i className="mr-2 inline-block h-[10px] w-[10px] rounded-[2px] bg-pie4 align-[-1px] opacity-40" />
                          )}
                          {c.label}
                        </Link>
                      </td>
                      <td className="py-1.5 text-right font-money text-[0.85rem] tabular">{amount(c.spending)}</td>
                      <td
                        className={`py-1.5 text-right font-money text-[0.78rem] tabular ${
                          c.deltaPct === null
                            ? "text-faint"
                            : c.deltaPct > 0.005
                              ? "font-semibold text-neg"
                              : c.deltaPct < -0.005
                                ? "font-semibold text-pos"
                                : "text-faint"
                        }`}
                      >
                        {c.deltaPct === null
                          ? "new"
                          : c.deltaPct > 9.99
                            ? `×${(1 + c.deltaPct).toFixed(1)}`
                            : pct(c.deltaPct)}
                      </td>
                      <td className="py-1.5 text-right font-money text-[0.78rem] tabular text-faint">
                        {Math.round(c.share * 100)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <SectionTitle>Cash flow by month</SectionTitle>
          <div className="mb-2 flex gap-5 text-[0.75rem] text-faint">
            <span>
              <i className="mr-1.5 inline-block h-[10px] w-[10px] rounded-[2px] bg-chart2 align-[-1px]" />
              Income
            </span>
            <span>
              <i className="mr-1.5 inline-block h-[10px] w-[10px] rounded-[2px] bg-chart1 align-[-1px]" />
              Spending
            </span>
          </div>
          <CashFlowChart months={data.cashFlow} />
        </section>
      </div>

      <section>
        <SectionTitle>Net worth</SectionTitle>
        <p className="mb-3 text-[0.75rem] text-faint">
          Month-end, all accounts. Hover for exact figures; months marked estimated lack a balance snapshot
          for at least one account.
        </p>
        <NetWorthChart months={data.netWorth} />
      </section>
    </div>
  );
}
