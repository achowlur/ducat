"use client";

import { sliceFill } from "../../lib/ui/donutColors";
import { amount, money, monthAbbrev, monthLabel, shortMonthLabel } from "../../lib/ui/format";
import { MONTH_KEY, spanName, type ExploreSpanKey, type GroupedSeries, type MonthSeries } from "../../lib/ui/report";
import {
  E_DEFAULTS,
  E_GROUP_VIEWS,
  E_MONTH_VIEWS,
  type EGroupView,
  type EMonthView,
  type ExploreBy,
  type ExploreShow,
} from "../../lib/ui/trendsParams";
import { TimeChart, type TimeSeries } from "../charts/report/TimeChart";
import { CardFrame, CardLink, Fig, Hero, Lead } from "./CardFrame";
import { PartsView } from "./PartsView";
import { ReportSelect, type SelectOption } from "./ReportSelect";
import { useCardView, ViewSwitch } from "./ViewSwitch";

export type ExploreData =
  | { kind: "months"; series: MonthSeries }
  | { kind: "groups"; grouped: GroupedSeries }
  | { kind: "empty" };

const TH = "py-1 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint";
const NOUNS: Record<Exclude<ExploreBy, "month">, string> = {
  category: "categories",
  merchant: "merchants",
  account: "accounts",
};
const OVERS: { value: ExploreSpanKey; label: string }[] = [
  { value: "month", label: "This month so far" },
  { value: "lastmonth", label: "Last month" },
  { value: "ytd", label: "This year so far" },
  { value: "lastyear", label: "Last year" },
  { value: "12m", label: "Last 12 months" },
  { value: "24m", label: "Last 24 months" },
  { value: "all", label: "All history" },
];
const BYS: { value: ExploreBy; label: string }[] = [
  { value: "month", label: "Month" },
  { value: "category", label: "Category" },
  { value: "merchant", label: "Merchant" },
  { value: "account", label: "Card or account" },
];

/**
 * Any of the page's questions, asked directly: what to total (spending,
 * income, or both by month), how to split it (by month, or by category,
 * merchant or account), for what (everything, or one category or account),
 * and over which months. The SHAPE of the answer decides the charts offered:
 * one series over months is a line, bars or a table; groups over a span are
 * parts of a whole (bars, pie, table) or each group across the months
 * (lines, stacked).
 */
export function ExploreCard({
  data,
  show,
  by,
  forValue,
  forLabel,
  forOptions,
  over,
  currentMonth,
  initialView,
}: {
  data: ExploreData;
  show: ExploreShow;
  by: ExploreBy;
  /** The `e.for` parameter, "" for everything. */
  forValue: string;
  forLabel: string | null;
  forOptions: SelectOption[];
  /** A preset or one month's key ("2026-09"), as Overview links one. */
  over: string;
  /** The month being lived in, from the page's one `now`. */
  currentMonth: string;
  initialView: string;
}) {
  const [view, setView] = useCardView<string>("e", initialView);
  const shows: SelectOption[] = [
    { value: "spending", label: "Spending" },
    { value: "income", label: "Income" },
    ...(by === "month" ? [{ value: "both", label: "Income and spending" }] : []),
  ];
  const controls = (
    <>
      <ReportSelect name="e.show" label="Show" value={show} fallback={E_DEFAULTS.show} options={shows} />
      <ReportSelect name="e.by" label="By" value={by} fallback={E_DEFAULTS.by} options={BYS} />
      <ReportSelect name="e.for" label="For" value={forValue} fallback="" options={forOptions} />
      <ReportSelect
        name="e.over"
        label="Over"
        value={over}
        fallback={E_DEFAULTS.over}
        options={
          // A month named outright (Overview's "full breakdown") matches no
          // preset, so it gets a synthetic entry, or the select would show
          // another span than the one on screen and drop it on the next change.
          MONTH_KEY.test(over)
            ? [{ value: over, label: `${monthLabel(over)}${over === currentMonth ? " so far" : ""}` }, ...OVERS]
            : OVERS
        }
      />
    </>
  );
  const options = by === "month" ? [...E_MONTH_VIEWS] : [...E_GROUP_VIEWS];
  const what = show === "both" ? "Income and spending" : show === "spending" ? "Spending" : "Income";
  // The month being lived in is never complete: its name says so.
  const title = (span: { from: string; to: string }) =>
    `${spanName(span)}${span.from === currentMonth && span.to === currentMonth ? " so far" : ""}`;
  const scope = forLabel === null ? "" : ` for ${forLabel}`;

  return (
    <CardFrame
      id="build-your-own"
      title="Build your own"
      switcher={<ViewSwitch options={options} value={view} onChange={setView} />}
      controls={controls}
    >
      {data.kind === "empty" ? (
        <p className="py-4 text-[0.85rem] text-faint">No complete month is on record for these months yet.</p>
      ) : data.kind === "months" ? (
        <Months series={data.series} what={what} scope={scope} view={view as EMonthView} title={title(data.series.span)} />
      ) : (
        <Groups
          grouped={data.grouped}
          what={what}
          scope={scope}
          by={by as Exclude<ExploreBy, "month">}
          view={view as EGroupView}
          title={title(data.grouped.span)}
        />
      )}
    </CardFrame>
  );
}

function Months({
  series,
  what,
  scope,
  view,
  title,
}: {
  series: MonthSeries;
  what: string;
  scope: string;
  view: EMonthView;
  title: string;
}) {
  const measures = (["income", "spending"] as const).filter((m) => series.values[m] !== undefined);
  const sum = (m: "income" | "spending") =>
    Math.round((series.values[m] ?? []).reduce((s, v) => s + Math.round(v * 100), 0)) / 100;
  const lines: TimeSeries[] = measures.map((m) => ({
    name: m === "income" ? "Income" : "Spending",
    color: m === "income" ? "var(--chart2)" : "var(--chart1)",
    values: series.values[m] as number[],
  }));
  const both = measures.length === 2;
  const net = both ? Math.round((sum("income") - sum("spending")) * 100) / 100 : 0;

  return (
    <>
      {both ? (
        // Both measures: the figure that joins them is what was left over.
        <Hero figure={money(net)} tone={net < 0 ? "neg" : undefined}>
          <Lead>Net, {title}</Lead>: income <Fig>{money(sum("income"))}</Fig>, spending{" "}
          <Fig>{money(sum("spending"))}</Fig>.
        </Hero>
      ) : (
        <Hero figure={money(sum(measures[0]))}>
          <Lead>
            {what}
            {scope}, {title}
          </Lead>
          {series.months.length > 1 && (
            <>
              : an average of <Fig>{money(Math.round((sum(measures[0]) / series.months.length) * 100) / 100)}</Fig> a
              month
            </>
          )}
          .
        </Hero>
      )}
      {view === "table" ? (
        <table className="w-full max-w-[560px] border-collapse">
          <thead>
            <tr className="border-b border-ink">
              <th scope="col" className={`${TH} text-left`}>
                Month
              </th>
              {lines.map((l) => (
                <th key={l.name} scope="col" className={`${TH} pl-3 text-right`}>
                  {l.name}
                </th>
              ))}
              {both && (
                <th scope="col" className={`${TH} pl-3 text-right`}>
                  Net
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {series.months.map((m, i) => (
              <tr key={m} className="border-b border-rule">
                <th scope="row" className="py-1 text-left text-[0.85rem] font-normal">
                  {shortMonthLabel(m)}
                </th>
                {lines.map((l) => (
                  <td key={l.name} className="py-1 pl-3 text-right font-money text-[0.85rem] tabular">
                    {amount(l.values[i] as number)}
                  </td>
                ))}
                {both && (
                  <td className="py-1 pl-3 text-right font-money text-[0.85rem] tabular text-faint">
                    {amount(Math.round(((series.values.income?.[i] ?? 0) - (series.values.spending?.[i] ?? 0)) * 100) / 100)}
                  </td>
                )}
              </tr>
            ))}
            <tr className="border-t-2 border-ink font-semibold">
              <th scope="row" className="py-1.5 text-left text-[0.85rem]">
                Total
              </th>
              {measures.map((m) => (
                <td key={m} className="py-1.5 pl-3 text-right font-money text-[0.85rem] tabular">
                  {amount(sum(m))}
                </td>
              ))}
              {both && <td className="py-1.5 pl-3 text-right font-money text-[0.85rem] tabular">{amount(net)}</td>}
            </tr>
          </tbody>
        </table>
      ) : (
        <TimeChart
          kind={view === "bars" ? "bars" : "line"}
          labels={series.months.map(monthAbbrev)}
          headings={series.months.map(shortMonthLabel)}
          years={series.months.map((m) => m.slice(0, 4))}
          series={lines}
          initial={series.months.length - 1}
          ariaLabel={`${what}${scope} by month, ${title}`}
        />
      )}
      <div className="flex flex-wrap gap-x-5">
        {measures.map((m) => (
          <CardLink key={m} href={series.href[m] as string}>
            {both ? `The ${m}` : "These transactions"}
          </CardLink>
        ))}
      </div>
    </>
  );
}

function Groups({
  grouped,
  what,
  scope,
  by,
  view,
  title,
}: {
  grouped: GroupedSeries;
  what: string;
  scope: string;
  by: Exclude<ExploreBy, "month">;
  view: EGroupView;
  title: string;
}) {
  const noun = NOUNS[by];
  const overTime: TimeSeries[] = grouped.lines.map((l, i) => ({
    name: l.label,
    color: sliceFill({ isOther: false }, i),
    values: l.byMonth,
  }));
  if (view === "stacked" && grouped.restByMonth !== null) {
    overTime.push({ name: "Everything else", color: sliceFill({ isOther: true }, 0), values: grouped.restByMonth });
  }
  return (
    <>
      <Hero figure={money(grouped.total)}>
        <Lead>
          {what}
          {scope} by {by === "account" ? "card or account" : by}, {title}
        </Lead>
        : {grouped.groups.length} {grouped.groups.length === 1 ? noun.replace(/ies$/, "y").replace(/s$/, "") : noun}.
      </Hero>
      {view === "lines" || view === "stacked" ? (
        grouped.lines.length === 0 ? (
          <p className="py-4 text-[0.85rem] text-faint">Nothing to draw over these months.</p>
        ) : (
          <>
            <TimeChart
              kind={view === "lines" ? "line" : "stacked"}
              labels={grouped.months.map(monthAbbrev)}
              headings={grouped.months.map(shortMonthLabel)}
              years={grouped.months.map((m) => m.slice(0, 4))}
              series={overTime}
              initial={grouped.months.length - 1}
              ariaLabel={`${what}${scope} by ${by}, month by month`}
            />
            {view === "lines" && grouped.groups.length > grouped.lines.length && (
              <p className="mt-2 text-[0.72rem] text-faint">
                The {grouped.lines.length} largest of {grouped.groups.length} {noun}; Stacked adds the rest as one band,
                and Table names every one.
              </p>
            )}
          </>
        )
      ) : (
        <PartsView view={view} groups={grouped.groups} total={grouped.total} noun={noun} />
      )}
    </>
  );
}
