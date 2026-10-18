import type { ReactNode } from "react";
import { monthAbbrev } from "../../lib/ui/format";
import type { YearGrowth } from "../../lib/ui/netWorthGrowth";
import { COLUMN_HEADER, SubsectionTitle } from "../ui/headings";
import { Fold, Note } from "./CardFrame";
import { Swatch } from "./GrowthSplit";

/** Whole dollars with a true minus: five figure columns fit a phone only without cents. */
function dollars(n: number): string {
  const text = Math.abs(n).toLocaleString("en-US");
  return n < 0 ? `−${text}` : text;
}

/**
 * A growth rate as a reader takes it in: whole percents from 100 up, where a
 * decimal adds nothing ("+917%"), one decimal below ("+33.6%"). True minus.
 */
export function growthRate(fraction: number): string {
  const percent = fraction * 100;
  const text = Math.abs(percent) >= 100 ? Math.round(Math.abs(percent)).toLocaleString("en-US") : Math.abs(percent).toFixed(1);
  return `${percent < 0 ? "−" : "+"}${text}%`;
}

interface Row {
  year: YearGrowth;
  change: number;
  saved: number;
  markets: number;
}

/**
 * Saved and markets for one year as bars on ONE scale shared by every row, so
 * a year's bar is as long as its growth: what grew it reads across the rows,
 * not only within one. Growth runs right of a zero line and a fall runs left,
 * saved always beside the line, the two parts parted by a 2px gap.
 */
function SplitBar({ row, maxUp, maxDown }: { row: Row; maxUp: number; maxDown: number }) {
  const whole = maxUp + maxDown;
  if (whole === 0) return null;
  const part = (n: number, side: number) => `${((Math.abs(n) / side) * 100).toFixed(2)}%`;
  const up = [
    ...(row.saved > 0 ? [{ key: "saved", n: row.saved, cls: "bg-chart1" }] : []),
    ...(row.markets > 0 ? [{ key: "markets", n: row.markets, cls: "bg-chart2" }] : []),
  ];
  const down = [
    ...(row.markets < 0 ? [{ key: "markets", n: row.markets, cls: "bg-chart2" }] : []),
    ...(row.saved < 0 ? [{ key: "saved", n: row.saved, cls: "bg-chart1" }] : []),
  ];
  return (
    <div className="flex h-2 w-full" aria-hidden>
      {maxDown > 0 && (
        <div className="flex justify-end gap-[2px]" style={{ width: `${((maxDown / whole) * 100).toFixed(2)}%` }}>
          {down.map((d) => (
            <div key={d.key} className={`${d.cls} first:rounded-l-[2px]`} style={{ width: part(d.n, maxDown) }} />
          ))}
        </div>
      )}
      <div
        className={`flex gap-[2px] ${maxDown > 0 ? "border-l border-rule" : ""}`}
        style={{ width: `${((maxUp / whole) * 100).toFixed(2)}%` }}
      >
        {up.map((u) => (
          <div key={u.key} className={`${u.cls} last:rounded-r-[2px]`} style={{ width: part(u.n, maxUp) }} />
        ))}
      </div>
    </div>
  );
}

const NUM = "py-2 pr-2 text-right font-money tabular";
const neg = (n: number) => (n < 0 ? "text-neg" : "");

/**
 * Each calendar year's growth, newest first, with what made it: saved and
 * markets as figures and as a bar. Rounded to dollars, saved is printed as the
 * rounded change less the rounded markets and the rounded accounts joining,
 * so every row adds up as printed with the note under the table.
 */
export function NetWorthYears({ years }: { years: YearGrowth[] }) {
  if (years.length === 0) return null;
  const rows: Row[] = years.map((y) => {
    const change = Math.round(y.change);
    const markets = Math.round(y.markets);
    const joined = Math.round(y.joined);
    return { year: y, change, markets, saved: change - markets - joined };
  });
  const joinedYears = rows.filter((r) => Math.round(r.year.joined) !== 0);
  const maxUp = Math.max(0, ...rows.map((r) => Math.max(r.saved, 0) + Math.max(r.markets, 0)));
  const maxDown = Math.max(0, ...rows.map((r) => Math.max(-r.saved, 0) + Math.max(-r.markets, 0)));
  // A star marks a year that leans on estimates only when some year does not:
  // on every row it says nothing, and the note says it once instead.
  const allEstimated = years.every((y) => y.uncertainMonths > 0);
  const anyEstimated = years.some((y) => y.uncertainMonths > 0);

  const head = (label: ReactNode, extra = "") => (
    <th scope="col" className={`${COLUMN_HEADER} py-1.5 pr-2 text-right ${extra}`}>
      {label}
    </th>
  );

  return (
    <div className="mt-8">
      <SubsectionTitle>By year</SubsectionTitle>
      <table className="mt-2 w-full max-w-[880px] text-[0.85rem]">
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className={`${COLUMN_HEADER} py-1.5 pr-2 text-left`}>
              Year
            </th>
            {head("Change")}
            {head("Growth")}
            {head(
              <span className="inline-flex items-center gap-1">
                <Swatch part="saved" />
                Saved
              </span>,
            )}
            {head(
              <span className="inline-flex items-center gap-1">
                <Swatch part="markets" />
                Markets
              </span>,
              "md:pr-6",
            )}
            <th scope="col" className={`${COLUMN_HEADER} hidden w-[34%] py-1.5 text-left md:table-cell`}>
              Saved and markets
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const y = r.year;
            return [
              <tr key={y.year} className="md:border-b md:border-rule/60">
                <th scope="row" className="py-2 pr-2 text-left align-baseline font-normal text-ink">
                  <span className="font-medium">{y.year}</span>
                  {!allEstimated && y.uncertainMonths > 0 ? "*" : ""}
                  {(y.soFar || y.fromInside) && (
                    <span className="block text-[0.7rem] text-faint md:ml-1.5 md:inline">
                      {y.fromInside ? `from ${monthAbbrev(y.from)}` : "so far"}
                    </span>
                  )}
                </th>
                <td className={`${NUM} align-baseline ${neg(r.change)}`}>{dollars(r.change)}</td>
                <td className={`${NUM} align-baseline ${y.pct === null ? "text-faint" : neg(y.pct)}`}>
                  {y.pct === null ? "—" : growthRate(y.pct)}
                </td>
                <td className={`${NUM} align-baseline ${neg(r.saved)}`}>{dollars(r.saved)}</td>
                <td className={`${NUM} align-baseline md:pr-6 ${neg(r.markets)}`}>{dollars(r.markets)}</td>
                <td className="hidden py-2 align-middle md:table-cell">
                  <SplitBar row={r} maxUp={maxUp} maxDown={maxDown} />
                </td>
              </tr>,
              // Below md the bar takes a line of its own under its year: a
              // sixth column does not fit 327px beside five figures.
              <tr key={`${y.year}-bar`} className="border-b border-rule/60 md:hidden">
                <td colSpan={5} className="pb-2.5">
                  <SplitBar row={r} maxUp={maxUp} maxDown={maxDown} />
                </td>
              </tr>,
            ];
          })}
        </tbody>
      </table>
      {(anyEstimated || joinedYears.length > 0) && (
        <Note>
          {allEstimated && <>Every year includes partly estimated months, so every split is partly estimated too.</>}
          {!allEstimated && anyEstimated && <>A year marked * includes partly estimated months, so its split is too.</>}
          {joinedYears.length > 0 && (
            <span className="text-ink">
              {" "}
              Accounts joining the total moved{" "}
              {joinedYears.map((r, k) => `${k > 0 ? ", " : ""}${r.year.year} by ${Math.round(r.year.joined) < 0 ? "−$" : "$"}${dollars(Math.abs(Math.round(r.year.joined)))}`).join("")}; that
              is in Change, and in neither Saved nor Markets.
            </span>
          )}
        </Note>
      )}
      <Fold label="How the years are worked out">
        <Note>
          Each year runs from the December before it to its last month on record, in whole dollars. Markets is how much
          your investment accounts moved beyond the money put in or taken out; saved is everything else that moved your
          balances, which is income left after spending, interest included. Growth is the change against where the year
          started, and none is printed when that start was zero or below. The bars share one scale, so a longer bar is a
          bigger year.
        </Note>
      </Fold>
    </div>
  );
}
