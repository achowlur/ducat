"use client";

import { useSearchParams } from "next/navigation";
import { amount, monthAbbrev } from "../../lib/ui/format";
import type { MonthSoFar } from "../../lib/ui/report";
import { A_VIEWS, type AView } from "../../lib/ui/trendsParams";
import { ChartReadout, TimeChart, type TimeSeries } from "../charts/report/TimeChart";
import { CardFrame, CardLink, Note } from "./CardFrame";
import { useCardView, ViewSwitch } from "./ViewSwitch";
import { COLUMN_HEADER } from "../ui/headings";

const TH = `py-1 ${COLUMN_HEADER}`;

function fullMonth(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
}

/**
 * The month being lived in, day by day, against last month and against what
 * the recent months usually looked like by the same day. Rent landing on the
 * 1st makes every month's line jump at the start; the band is what tells a
 * normal jump from a bad one.
 *
 * The readout IS the card's answer, opening on today: a sentence above it
 * stating the same three figures said everything twice.
 */
export function MonthSoFarCard({ data, initialView }: { data: MonthSoFar; initialView: AView }) {
  const [view, setView] = useCardView<AView>("a", initialView);
  // The pace says HOW MUCH; the next question is ON WHAT. One step to the
  // comparison that answers it, keeping every other card's question.
  const search = useSearchParams();
  const driving = new URLSearchParams(search.toString());
  driving.set("b.span", "mtd");
  const now = fullMonth(data.month);
  const before = fullMonth(data.previous);
  const mon = monthAbbrev(data.month);
  const pad = (xs: number[]) => [...xs, ...new Array<null>(Math.max(data.days - xs.length, 0)).fill(null)];
  const labels = Array.from({ length: data.days }, (_, i) => String(i + 1));
  const headings = labels.map((d) => `${mon} ${d}`);
  const running: TimeSeries[] = [
    { name: now, color: "var(--chart1)", values: pad(data.current) },
    { name: `${before} by then`, color: "var(--faint)", values: data.last, muted: true },
  ];
  const band = data.band === null ? undefined : { low: data.band.low, high: data.band.high };
  // Today's figure counts only what has posted; say when the newest record
  // trails today, or "below typical" on the 3rd reads as a verdict on days
  // the bank has not reported yet.
  const newest = data.newest ?? { month: data.month, day: 0 };
  const lagging = newest.month < data.month || (newest.month === data.month && newest.day < data.today);

  // Rent on the 1st dwarfs every other day; past three times the third
  // largest, the tallest bars run off the top and print their own figure.
  const daily = [...data.currentDaily, ...data.lastDaily].filter((v) => v > 0).sort((a, b) => b - a);
  const cap = daily.length >= 3 && daily[0] > daily[2] * 3 ? daily[2] * 1.25 : undefined;

  return (
    <CardFrame title="This month so far" switcher={<ViewSwitch options={[...A_VIEWS]} value={view} onChange={setView} />}>
      {view === "table" ? (
        <>
          <ChartReadout
            heading={headings[data.today - 1]}
            series={running}
            kind="line"
            band={band}
            index={data.today - 1}
            hero
          />
          <table className="w-full max-w-[560px] border-collapse">
            <thead>
              <tr className="border-b border-ink">
                <th scope="col" className={`${TH} text-left`}>
                  Day
                </th>
                <th scope="col" className={`${TH} pl-3 text-right`}>
                  {now}
                </th>
                <th scope="col" className={`${TH} pl-3 text-right`}>
                  {before}
                </th>
                <th scope="col" className={`${TH} pl-3 text-right`}>
                  Difference
                </th>
              </tr>
            </thead>
            <tbody>
              {data.current.map((v, i) => {
                const diff = Math.round((v - data.last[i]) * 100) / 100;
                return (
                  <tr key={i} className="border-b border-rule">
                    <th scope="row" className="py-1 text-left text-[0.85rem] font-normal">
                      {mon} {i + 1}
                    </th>
                    <td className="py-1 pl-3 text-right font-money text-[0.85rem] tabular">{amount(v)}</td>
                    <td className="py-1 pl-3 text-right font-money text-[0.85rem] tabular text-faint">
                      {amount(data.last[i])}
                    </td>
                    <td
                      className={`py-1 pl-3 text-right font-money text-[0.85rem] tabular ${
                        diff > 0 ? "text-neg" : diff < 0 ? "text-pos" : "text-faint"
                      }`}
                    >
                      {diff > 0 ? "+" : ""}
                      {amount(diff)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : (
        <TimeChart
          kind={view === "running" ? "line" : "bars"}
          labels={labels}
          headings={headings}
          series={
            view === "running"
              ? running
              : [
                  { name: now, color: "var(--chart1)", values: pad(data.currentDaily) },
                  { name: before, color: "var(--faint)", values: data.lastDaily, muted: true },
                ]
          }
          band={view === "running" ? band : undefined}
          cap={view === "daily" ? cap : undefined}
          initial={data.today - 1}
          phoneFit={31}
          hero
          ariaLabel={`Spending each day of ${now} against ${before}`}
        />
      )}
      {(lagging || view !== "daily") && (
        <Note>
          {view === "table" && "Each row is everything spent from the 1st to that day. "}
          {lagging && (
            <>
              Recorded through {monthAbbrev(newest.month)} {newest.day}; the days since fill in as transactions
              post.{" "}
            </>
          )}
          {view !== "daily" &&
            (data.band === null
              ? "No typical range yet: it needs three complete months of records among the last six."
              : `Typical is the middle half of ${fullMonth(data.band.months[0])} to ${fullMonth(
                  data.band.months[data.band.months.length - 1],
                )} at the same day of the month.`)}
        </Note>
      )}
      <CardLink href={`/trends?${driving.toString()}#what-changed`}>What changed this month</CardLink>
    </CardFrame>
  );
}
