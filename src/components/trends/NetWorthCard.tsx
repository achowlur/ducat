"use client";

import { useState } from "react";
import { fullWindow, isFull, shownMonths, type ChartWindow } from "../../lib/ui/chartZoom";
import { money, monthAbbrev, pct, shortMonthLabel } from "../../lib/ui/format";
import { growthBetween, growthByYear, type YearGrowth } from "../../lib/ui/netWorthGrowth";
import { wholePercents } from "../../lib/ui/spendingBreakdown";
import { NetWorthChart } from "../charts/NetWorthChart";
import { COLUMN_HEADER, SubsectionTitle } from "../ui/headings";
import { CardFrame, Fig, Hero, Lead, Note } from "./CardFrame";

export interface NetWorthMonth {
  period: string;
  label: string;
  value: number;
  estimated: boolean;
  leftOut: string[];
  marketGains: number | null;
}

/** Whole dollars with a true minus: the by-year columns fit a phone only without cents. */
function dollars(n: number): string {
  const whole = Math.round(n);
  const text = Math.abs(whole).toLocaleString("en-US");
  return whole < 0 ? `−${text}` : text;
}

const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
const toneOf = (n: number): "pos" | "neg" | undefined => (n > 0 ? "pos" : n < 0 ? "neg" : undefined);

/** "2024", "2026 so far", "2018 from Nov": the span a year's row measures. */
function yearLabel(y: YearGrowth): string {
  if (y.fromInside) return `${y.year} from ${monthAbbrev(y.from)}`;
  return y.soFar ? `${y.year} so far` : y.year;
}

/**
 * Net worth, zoomed wherever the reader pinches or scrolls, and what moved it
 * over the months on show: the markets, or money kept. The window lives here,
 * not in the chart, because the figures above the line follow it. Every month
 * is already on the page, so zooming asks the server nothing.
 */
export function NetWorthCard({
  months,
  spendingFrom,
}: {
  months: NetWorthMonth[];
  /** The first month of the spending history, for the note when this line is shorter. */
  spendingFrom: string | null;
}) {
  const [shownWindow, setWindow] = useState<ChartWindow>(() => fullWindow(months.length));
  // A new history (a statement import, a sync) resets the zoom rather than
  // holding a window measured against the old one.
  const [anchorCount, setAnchorCount] = useState(months.length);
  if (anchorCount !== months.length) {
    setAnchorCount(months.length);
    setWindow(fullWindow(months.length));
  }

  const historyStartsHere = (
    <p className="mb-3 border-l-2 border-warn bg-chip/50 px-2.5 py-1.5 text-[0.75rem] text-faint">
      <span className="font-semibold text-acc">History starts here.</span> A month appears once an account has a
      value in it. Imported transactions can&apos;t give a brokerage one: its value moves with the market, which
      leaves no transaction to reconstruct from. Statement imports and month-end balances supply earlier months, and
      each sync records a value, so this line grows from today forward.
    </p>
  );

  // Analyzers legitimately emit nothing: no month has a value yet.
  if (months.length === 0) {
    return (
      <CardFrame id="net-worth" title="Net worth" switcher={null}>
        {historyStartsHere}
        <NetWorthChart months={[]} window={shownWindow} onWindow={setWindow} />
      </CardFrame>
    );
  }

  const zoomed = !isFull(shownWindow, months.length);
  const { first, last } = shownMonths(shownWindow);
  const shown = months.slice(first, last + 1);
  const growth = last > first ? growthBetween(months, first, last) : null;
  const years = growthByYear(months);
  const estimatedMonths = shown.filter((m) => m.estimated).length;
  // Each account a shown month leaves out, with the LAST month it is missing from.
  const leftOut = [...new Set(shown.flatMap((m) => m.leftOut))].map((name) => ({
    name,
    through: shown.filter((m) => m.leftOut.includes(name)).at(-1)?.period ?? "",
  }));
  // The markets' share is stated only when both parts grew: a share of a
  // whole that one part shrank is not a share of anything.
  const [savedShare, marketShare] =
    growth !== null && growth.saved > 0 && growth.markets > 0
      ? wholePercents([growth.saved / growth.change, growth.markets / growth.change])
      : [null, null];

  const reset = zoomed ? (
    <button
      type="button"
      onClick={() => setWindow(fullWindow(months.length))}
      className="tap44 rounded-sm border border-rule px-2 py-0.5 text-[0.75rem] text-faint hover:text-ink"
    >
      Show all months
    </button>
  ) : null;

  return (
    <CardFrame id="net-worth" title="Net worth" switcher={reset}>
      {growth !== null && (
        <Hero figure={signedMoney(growth.change)} tone={toneOf(growth.change)}>
          <Lead>
            {shortMonthLabel(growth.from)} to {shortMonthLabel(growth.to)}
          </Lead>
          {/* From the first month on record the base is wherever the records
              happen to begin, often a near-empty first account, so its ratio
              describes the records, not the growth. Zoomed past it, the base
              is a real month-end. */}
          {growth.pct !== null && first > 0 && (
            <>
              {" "}
              · <Fig tone={toneOf(growth.pct)}>{`${growth.pct >= 0 ? "▲" : "▼"} ${pct(Math.abs(growth.pct)).slice(1)}`}</Fig>
            </>
          )}{" "}
          · saved <Fig>{money(growth.saved)}</Fig> · markets <Fig>{money(growth.markets)}</Fig>
          {marketShare !== null && savedShare !== null && (
            <>
              {" "}
              · <Fig>{marketShare}%</Fig> of it from markets
            </>
          )}
        </Hero>
      )}

      <p className="mb-3 text-[0.75rem] text-faint">
        Month-end, {leftOut.length === 0 ? "all accounts" : "every account with a value that month"},{" "}
        <span className="text-ink">{shortMonthLabel(shown[0].period)}</span> to{" "}
        <span className="text-ink">{shortMonthLabel(shown[shown.length - 1].period)}</span>. Hover or tap a month for
        exact figures. Pinch to zoom in anywhere and slide two fingers to move along; on a computer, Ctrl and scroll
        (or pinch the trackpad) and drag. The figures above follow the months on show. A dashed line and a hollow
        point mark a month to discount: partly estimated (an investment account&apos;s value carried from an earlier
        month, its market movement since unseen, or a balance worked out from transactions), or leaving an account
        out.
        {/* How MANY are estimated is a fact about the whole line, not a
            per-point footnote: six of seven is a reason to discount the
            slope, and it was reachable only by hovering each month in turn. */}
        {estimatedMonths > 0 && (
          <>
            {" "}
            <span className="text-ink">
              {estimatedMonths} of {shown.length} month{shown.length === 1 ? "" : "s"}{" "}
              {estimatedMonths === 1 ? "is" : "are"} partly estimated
            </span>
            .
          </>
        )}
        {/* A month missing an account is SMALLER than the truth, so the
            account is named in text, with the last month it is missing from:
            never left for a hover to reveal. */}
        {leftOut.length > 0 && (
          <>
            {" "}
            <span className="text-ink">
              Left out where it has no value yet:{" "}
              {leftOut.map((l) => `${l.name} (through ${shortMonthLabel(l.through)})`).join(", ")}
            </span>
            .
          </>
        )}
        {!zoomed && spendingFrom !== null && months[0].period > spendingFrom && (
          <> Shorter than the spending history above: a month appears once some account has a value in it.</>
        )}
      </p>
      {months.length < 3 && historyStartsHere}
      <NetWorthChart months={months} window={shownWindow} onWindow={setWindow} />

      {years.length > 0 && (
        <div className="mt-6">
          <SubsectionTitle>By year</SubsectionTitle>
          <table className="mt-2 w-full max-w-[640px] text-[0.85rem]">
            <thead>
              <tr className="border-b border-rule">
                <th scope="col" className={`${COLUMN_HEADER} py-1 pr-2 text-left`}>
                  Year
                </th>
                <th scope="col" className={`${COLUMN_HEADER} py-1 pr-2 text-right`}>
                  Change
                </th>
                <th scope="col" className={`${COLUMN_HEADER} py-1 pr-2 text-right`}>
                  Growth
                </th>
                <th scope="col" className={`${COLUMN_HEADER} py-1 pr-2 text-right`}>
                  Saved
                </th>
                <th scope="col" className={`${COLUMN_HEADER} py-1 text-right`}>
                  Markets
                </th>
              </tr>
            </thead>
            <tbody>
              {years.map((y) => {
                // Rounded to dollars, saved is what is left of the rounded
                // change, so every row still adds up as printed.
                const change = Math.round(y.change);
                const markets = Math.round(y.markets);
                return (
                  <tr key={y.year} className="border-b border-rule/60 align-top">
                    <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                      {yearLabel(y)}
                      {y.uncertainMonths > 0 ? "*" : ""}
                    </th>
                    <td className={`py-1.5 pr-2 text-right font-money tabular ${change < 0 ? "text-neg" : ""}`}>
                      {dollars(change)}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-money tabular">
                      {y.pct === null ? "—" : pct(y.pct)}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-money tabular">{dollars(change - markets)}</td>
                    <td className="py-1.5 text-right font-money tabular">{dollars(markets)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Note>
            Each year runs from the December before it to its last month on record, in whole dollars. Markets is how
            much your investment accounts moved beyond the money put in or taken out; saved is everything else that
            moved your balances, which is income left after spending, interest included. Growth is the change against
            where the year started, and none is printed when that start was zero or below.
            {years.some((y) => y.uncertainMonths > 0) && (
              <> A year marked * includes partly estimated months, so its split is too.</>
            )}
          </Note>
        </div>
      )}
    </CardFrame>
  );
}
