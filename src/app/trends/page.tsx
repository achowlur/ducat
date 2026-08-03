import Link from "next/link";
import { CashFlowChart } from "../../components/charts/CashFlowChart";
import { NetWorthChart } from "../../components/charts/NetWorthChart";
import { TrendsDonut } from "../../components/charts/TrendsDonut";
import { CoverageNotice } from "../../components/CoverageNotice";
import { amount, money, monthLabel, pct } from "../../lib/ui/format";
import { getPeriodCoverage } from "../../lib/ui/coverage";
import { getTrendsData } from "../../lib/ui/trends";

export const dynamic = "force-dynamic";

const DONUT_COLORS = ["bg-chart1", "bg-chart2", "bg-pie3", "bg-pie4"];

/** Month step: a 44px touch target below md, the original glyph above it. */
const ARROW = "inline-block px-1 text-center max-md:min-h-[44px] max-md:min-w-[44px] max-md:-my-3 max-md:py-3";

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
  const estimatedMonths = data.netWorth.filter((m) => m.estimated).length;

  return (
    <div className="grid gap-9 py-5">
      <CoverageNotice coverage={coverage} />
      {/* min-w-0: a grid item defaults to min-width:auto and will not shrink
          below its content, which is how a 520px chart widened the page. */}
      <div className="grid min-w-0 gap-9 lg:grid-cols-2">
        <section className="min-w-0">
          <div className="flex items-baseline justify-between">
            <SectionTitle>Spending by category</SectionTitle>
            <span className="flex items-center gap-2 font-money text-[0.78rem] text-faint">
              {data.prevPeriod !== null ? (
                <Link href={`/trends?period=${data.prevPeriod}`} className={`${ARROW} hover:text-ink`}>
                  ‹
                </Link>
              ) : (
                <span className={`${ARROW} opacity-30`}>‹</span>
              )}
              <span className="text-ink">{data.periodLabel}</span>
              {data.nextPeriod !== null ? (
                <Link href={`/trends?period=${data.nextPeriod}`} className={`${ARROW} hover:text-ink`}>
                  ›
                </Link>
              ) : (
                <span className={`${ARROW} opacity-30`}>›</span>
              )}
            </span>
          </div>
          {/* A refused ?period= used to leave the URL saying one month and the
              page showing another, with nothing between them. The clamp is
              correct — this page plots stored rows — so it is stated, not
              removed. */}
          {data.clampedFrom !== null && (
            <p className="mb-2 text-[0.75rem] text-faint">
              <span className="text-ink">{monthLabel(data.clampedFrom)}</span> has nothing recorded —
              showing {data.periodLabel}.
            </p>
          )}
          <p className="mb-3 text-[0.75rem] text-faint">
            {/* "Hover or tap for detail" promised something a phone cannot do:
                there is no hover, and a tap on a slice navigates. */}
            {/* The stepper sits in this section's header but scopes only this
                section, while the two charts are all-history. Nothing said so,
                which invites reading ‹ › as a page-wide control. */}
            <span className="text-ink">{data.periodLabel} only</span> — the charts alongside and below cover
            all history. Transfers excluded. Tap or click a slice or row to open those transactions; hover a
            slice for its exact share.
            {data.credited > 0 && (
              <>
                {" "}
                Shares are of the {money(data.drawable)} in categories with net spending — the total also
                nets {money(data.credited)} refunded elsewhere.
              </>
            )}
          </p>
          {data.donut === null ? (
            <p className="text-[0.85rem] text-faint">
              {data.categories.length === 0
                ? `No spending recorded in ${data.periodLabel}.`
                : // Spending happened, but reimbursements outran it. Saying
                  // "no spending" here is simply false — the rows below show
                  // real expenses.
                  `Reimbursements exceeded spending in ${data.periodLabel}, so there is no chart to draw. The categories below still show what was spent and credited.`}
            </p>
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
                          {/* No swatch for a category that ended in credit: it draws no arc. */}
                          {c.share === null ? (
                            <i className="mr-2 inline-block h-[10px] w-[10px] align-[-1px]" />
                          ) : i < 3 ? (
                            <i className={`mr-2 inline-block h-[10px] w-[10px] rounded-[2px] align-[-1px] ${DONUT_COLORS[i]}`} />
                          ) : (
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
                          ? // Three refusals, three different words, because the
                            // em dash already carries a second meaning in the
                            // Share column one cell to the right. No prior row
                            // at all is "new"; a PRIOR period that ended at zero
                            // or in credit leaves nothing to divide by; and a
                            // CURRENT period that ended in credit says what
                            // actually happened rather than reusing the dash.
                            c.previousSpending === null
                            ? "new"
                            : c.spending < 0
                              ? "refunded"
                              : "—"
                          : c.deltaPct > 9.99
                            ? `×${(1 + c.deltaPct).toFixed(1)}`
                            : pct(c.deltaPct)}
                      </td>
                      <td className="py-1.5 text-right font-money text-[0.78rem] tabular text-faint">
                        {c.share === null ? "—" : `${Math.round(c.share * 100)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="min-w-0">
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
          Month-end, all accounts
          {data.netWorth.length > 0 && (
            <>
              {" "}
              — <span className="text-ink">{data.netWorth[0].label}</span> to{" "}
              <span className="text-ink">{data.netWorth[data.netWorth.length - 1].label}</span>
            </>
          )}
          . Hover or tap a month for exact figures; months drawn with a dashed line and a hollow point lack
          a balance snapshot for at least one account.
          {/* How MANY are estimated is a fact about the whole line, not a
              per-point footnote — six of seven is a reason to discount the
              slope, and it was reachable only by hovering each month in turn. */}
          {estimatedMonths > 0 && (
            <>
              {" "}
              <span className="text-ink">
                {estimatedMonths} of {data.netWorth.length} month
                {data.netWorth.length === 1 ? "" : "s"} {estimatedMonths === 1 ? "is" : "are"} partly
                estimated
              </span>
              .
            </>
          )}
          {/* Two charts on one page spanning different ranges reads as a bug
              unless the shorter one says why it is shorter. Net worth REFUSES a
              month it cannot fully know, so its line is a record of when
              snapshots begin, not of when the money did. */}
          {data.netWorth.length > 0 && data.netWorth.length < data.cashFlow.length && (
            <>
              {" "}
              Shorter than cash flow above ({data.netWorth.length} months against {data.cashFlow.length})
              because a month appears only once every account has a balance snapshot inside it — earlier
              months are refused rather than estimated.
            </>
          )}
        </p>
        {data.netWorth.length < 3 && (
          <p className="mb-3 border-l-2 border-chart2 bg-chip/50 px-2.5 py-1.5 text-[0.75rem] text-faint">
            <span className="font-semibold text-acc">History starts here.</span> Net worth is only shown for
            months with a balance snapshot behind every account. Imported transactions can&apos;t supply one —
            a brokerage&apos;s value moves with the market, which leaves no transaction to reconstruct from, so
            earlier months would be guesses rather than history. Each sync records a snapshot, so this line
            grows from today forward.
          </p>
        )}
        <NetWorthChart months={data.netWorth} />
      </section>
    </div>
  );
}
