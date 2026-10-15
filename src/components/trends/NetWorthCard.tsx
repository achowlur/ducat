"use client";

import { money, monthAbbrev, pct, shortMonthLabel } from "../../lib/ui/format";
import {
  growthBetween,
  growthByYear,
  pointsIn,
  rangesFor,
  type NetWorthRange,
  type YearGrowth,
} from "../../lib/ui/netWorthGrowth";
import { wholePercents } from "../../lib/ui/spendingBreakdown";
import { NetWorthChart } from "../charts/NetWorthChart";
import { COLUMN_HEADER, SubsectionTitle } from "../ui/headings";
import { CardFrame, Fig, Hero, Lead, Note } from "./CardFrame";
import { useCardView, ViewSwitch } from "./ViewSwitch";

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
 * Net worth over a range the reader picks, and what moved it: the markets, or
 * money kept. Every month is already on the page, so the range is a VIEW, kept
 * like every card's chart choice (URL and cookie) and asking the server
 * nothing; the line rescales to the months it shows.
 */
export function NetWorthCard({
  months,
  initialRange,
  spendingFrom,
}: {
  months: NetWorthMonth[];
  initialRange: NetWorthRange;
  /** The first month of the spending history, for the note when this line is shorter. */
  spendingFrom: string | null;
}) {
  const [chosen, choose] = useCardView<NetWorthRange>("n", initialRange);
  const available = rangesFor(months.length);
  // A remembered range the history is too short for draws everything.
  const range = available.some((r) => r.value === chosen) ? chosen : "all";
  const shown = pointsIn(months, range);

  const switcher =
    available.length > 1 ? (
      <ViewSwitch label="Show" options={available.map((r) => ({ value: r.value, label: r.label }))} value={range} onChange={choose} />
    ) : null;

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
        <NetWorthChart months={[]} />
      </CardFrame>
    );
  }

  const growth = shown.length > 1 ? growthBetween(shown, 0, shown.length - 1) : null;
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

  return (
    <CardFrame id="net-worth" title="Net worth" switcher={switcher}>
      {growth !== null && (
        <Hero figure={signedMoney(growth.change)} tone={toneOf(growth.change)}>
          <Lead>
            {shortMonthLabel(growth.from)} to {shortMonthLabel(growth.to)}
          </Lead>
          {/* All measures from wherever the records happen to begin, often a
              near-empty first account, so its ratio describes the records,
              not the growth. A chosen range starts at a real month-end. */}
          {growth.pct !== null && range !== "all" && (
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
        exact figures. A dashed line and a hollow point mark a month to discount: partly estimated (an investment
        account&apos;s value carried from an earlier month, its market movement since unseen, or a balance worked out
        from transactions), or leaving an account out.
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
        {range === "all" && spendingFrom !== null && months[0].period > spendingFrom && (
          <> Shorter than the spending history above: a month appears once some account has a value in it.</>
        )}
      </p>
      {months.length < 3 && historyStartsHere}
      {/* Keyed by range: a hovered index from a longer range must not survive into a shorter one. */}
      <NetWorthChart key={range} months={shown} />

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
