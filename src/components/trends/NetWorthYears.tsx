import type { CSSProperties, ReactNode } from "react";
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

/** The hatched fill a lost part is drawn in: its own colour, so its identity holds. */
export function lossFill(color: string): CSSProperties {
  return {
    backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1.5px, transparent 1.5px 4px)`,
    boxShadow: `inset 0 0 0 1px ${color}`,
  };
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
 *
 * A loss is never thinner than LOSS_MIN_PX: a $36 loss beside a $50,000 year
 * drew a sliver nobody could see, so the hatch said nothing. The loss side
 * keeps room for the widest such row on EVERY row, so the zero line stays in
 * one place down the column.
 */
const LOSS_MIN_PX = 6;

function SplitBar({ row, maxUp, maxDown, lossRoom }: { row: Row; maxUp: number; maxDown: number; lossRoom: number }) {
  const whole = maxUp + maxDown;
  if (whole === 0) return null;
  const part = (n: number, side: number) => `${((Math.abs(n) / side) * 100).toFixed(2)}%`;
  const up = [
    ...(row.saved > 0 ? [{ key: "saved", n: row.saved, cls: "bg-chart1" }] : []),
    ...(row.markets > 0 ? [{ key: "markets", n: row.markets, cls: "bg-chart2" }] : []),
  ];
  const down = [
    ...(row.markets < 0 ? [{ key: "markets", n: row.markets, color: "var(--chart2)" }] : []),
    ...(row.saved < 0 ? [{ key: "saved", n: row.saved, color: "var(--chart1)" }] : []),
  ];
  return (
    <div className="flex h-2 w-full" aria-hidden>
      {maxDown > 0 && (
        <div
          className="flex shrink-0 justify-end gap-[2px]"
          style={{ width: `${((maxDown / whole) * 100).toFixed(2)}%`, minWidth: `${lossRoom}px` }}
        >
          {/* A LOSS is hatched in its part's colour and outlined: left of the
              line alone, a solid bar read as one more gain. */}
          {down.map((d) => (
            <div
              key={d.key}
              className="shrink-0 first:rounded-l-[2px]"
              style={{ width: part(d.n, maxDown), minWidth: `${LOSS_MIN_PX}px`, ...lossFill(d.color) }}
            />
          ))}
        </div>
      )}
      <div
        className={`flex min-w-0 flex-1 gap-[2px] ${maxDown > 0 ? "border-l border-rule" : ""}`}
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
  const anyLoss = rows.some((r) => r.saved < 0 || r.markets < 0);
  const maxUp = Math.max(0, ...rows.map((r) => Math.max(r.saved, 0) + Math.max(r.markets, 0)));
  const maxDown = Math.max(0, ...rows.map((r) => Math.max(-r.saved, 0) + Math.max(-r.markets, 0)));
  // Room on the loss side for the most loss parts any row draws, each at least LOSS_MIN_PX.
  const lossParts = Math.max(0, ...rows.map((r) => (r.saved < 0 ? 1 : 0) + (r.markets < 0 ? 1 : 0)));
  const lossRoom = lossParts === 0 ? 0 : lossParts * LOSS_MIN_PX + (lossParts - 1) * 2;
  // A star marks a year that leans on estimates only when some year does not:
  // on every row it says nothing, and the note says it once instead.
  const allEstimated = years.every((y) => y.uncertainMonths > 0);
  const anyEstimated = years.some((y) => y.uncertainMonths > 0);

  // Every header sits on the bottom line, the swatched ones included, and the
  // figure columns take fixed widths so the bar column, not the year, takes
  // what is left.
  const head = (label: ReactNode, extra = "") => (
    <th scope="col" className={`${COLUMN_HEADER} whitespace-nowrap py-1.5 pr-2 text-right align-bottom ${extra}`}>
      {label}
    </th>
  );
  const swatched = (part: "saved" | "markets", label: string) => (
    <>
      <span className="mr-1">
        <Swatch part={part} />
      </span>
      {label}
    </>
  );

  return (
    <div className="mt-8">
      <SubsectionTitle>By year</SubsectionTitle>
      {/* Below md a year is a small block, not a row of five figures: the
          change and growth on top, the bar at full width, then saved and
          markets beside their swatches. Five columns on 327px read as a
          wall of digits with the bars floating under it (operator, 2026-10-19). */}
      <ul className="mt-2 md:hidden">
        {rows.map((r) => {
          const y = r.year;
          return (
            <li key={y.year} className="border-b border-rule/60 py-2.5 first:border-t first:border-rule">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[0.9rem] text-ink">
                  <span className="font-medium">{y.year}</span>
                  {!allEstimated && y.uncertainMonths > 0 ? "*" : ""}
                  {(y.soFar || y.fromInside) && (
                    <span className="ml-1.5 text-[0.72rem] text-faint">
                      {y.fromInside ? `from ${monthAbbrev(y.from)}` : "so far"}
                    </span>
                  )}
                </span>
                <span className="whitespace-nowrap font-money text-[0.9rem] tabular">
                  <span className={neg(r.change)}>
                    {r.change > 0 ? "+" : ""}
                    {dollars(r.change)}
                  </span>
                  {y.pct !== null && (
                    <span className={`ml-2 text-[0.78rem] ${y.pct < 0 ? "text-neg" : "text-faint"}`}>{growthRate(y.pct)}</span>
                  )}
                </span>
              </div>
              <div className="mt-1.5">
                <SplitBar row={r} maxUp={maxUp} maxDown={maxDown} lossRoom={lossRoom} />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 text-[0.75rem] text-faint">
                <span className="inline-flex items-center gap-1.5">
                  <Swatch part="saved" />
                  saved <span className={`font-money tabular ${r.saved < 0 ? "text-neg" : "text-ink"}`}>{dollars(r.saved)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Swatch part="markets" />
                  markets{" "}
                  <span className={`font-money tabular ${r.markets < 0 ? "text-neg" : "text-ink"}`}>{dollars(r.markets)}</span>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <table className="mt-2 hidden w-full max-w-[880px] table-fixed text-[0.85rem] md:table">
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className={`${COLUMN_HEADER} w-[7.5rem] py-1.5 pr-2 text-left align-bottom`}>
              Year
            </th>
            {head("Change", "w-[6.5rem]")}
            {head("Growth", "w-[5.5rem]")}
            {head(swatched("saved", "Saved"), "w-[6.5rem]")}
            {head(swatched("markets", "Markets"), "w-[8rem] pr-6")}
            <th scope="col" className={`${COLUMN_HEADER} py-1.5 text-left align-bottom`}>
              Saved and markets
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const y = r.year;
            return (
              <tr key={y.year} className="border-b border-rule/60">
                <th scope="row" className="py-2 pr-2 text-left align-baseline font-normal text-ink">
                  <span className="font-medium">{y.year}</span>
                  {!allEstimated && y.uncertainMonths > 0 ? "*" : ""}
                  {(y.soFar || y.fromInside) && (
                    <span className="ml-1.5 text-[0.7rem] text-faint">
                      {y.fromInside ? `from ${monthAbbrev(y.from)}` : "so far"}
                    </span>
                  )}
                </th>
                <td className={`${NUM} align-baseline ${neg(r.change)}`}>{dollars(r.change)}</td>
                <td className={`${NUM} align-baseline ${y.pct === null ? "text-faint" : neg(y.pct)}`}>
                  {y.pct === null ? "—" : growthRate(y.pct)}
                </td>
                <td className={`${NUM} align-baseline ${neg(r.saved)}`}>{dollars(r.saved)}</td>
                <td className={`${NUM} align-baseline pr-6 ${neg(r.markets)}`}>{dollars(r.markets)}</td>
                <td className="py-2 align-middle">
                  <SplitBar row={r} maxUp={maxUp} maxDown={maxDown} lossRoom={lossRoom} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(anyEstimated || joinedYears.length > 0 || anyLoss) && (
        <Note>
          {anyLoss && (
            <span className="mr-1 inline-flex items-center gap-1 align-middle">
              <span aria-hidden className="inline-block h-[9px] w-[14px] rounded-[2px]" style={lossFill("var(--chart2)")} />
              A hatched bar, left of the line, is a loss.
            </span>
          )}
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
