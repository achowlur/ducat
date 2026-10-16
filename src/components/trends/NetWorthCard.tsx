"use client";

import { useState } from "react";
import { fullWindow, isFull, shownMonths, type ChartWindow } from "../../lib/ui/chartZoom";
import { money, shortMonthLabel } from "../../lib/ui/format";
import { growthBetween, growthByYear } from "../../lib/ui/netWorthGrowth";
import { NetWorthChart } from "../charts/NetWorthChart";
import { CardFrame, Fig, Hero, Lead, Note } from "./CardFrame";
import { GrowthSplit } from "./GrowthSplit";
import { growthRate, NetWorthYears } from "./NetWorthYears";

export interface NetWorthMonth {
  period: string;
  label: string;
  value: number;
  estimated: boolean;
  leftOut: string[];
  marketGains: number | null;
}

const signedMoney = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
const toneOf = (n: number): "pos" | "neg" | undefined => (n > 0 ? "pos" : n < 0 ? "neg" : undefined);

/** The chart's two line styles, drawn as the line draws them, for the key under it. */
function LineKey({ dashed }: { dashed: boolean }) {
  return (
    <svg aria-hidden width="22" height="8" className="shrink-0">
      <line x1="1" y1="4" x2="21" y2="4" stroke="var(--chart1)" strokeWidth="2" strokeLinecap="round" strokeDasharray={dashed ? "5,3" : undefined} />
    </svg>
  );
}

/**
 * Net worth, zoomed wherever the reader pinches or scrolls, and what moved it
 * over the months on show: the markets, or money kept. The window lives here,
 * not in the chart, because the figures above the line follow it. Every month
 * is already on the page, so zooming asks the server nothing.
 *
 * Read top to bottom: the change and its rate, what it was made of (one bar,
 * its parts named), the line, a one-line key to the line, then the small
 * print. The key replaced a nine-line paragraph that sat ABOVE the chart on a
 * phone, so the line began below the fold.
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
  const estimatedMonths = shown.filter((m) => m.estimated).length;
  // Each account a shown month leaves out, with the LAST month it is missing from.
  const leftOut = [...new Set(shown.flatMap((m) => m.leftOut))].map((name) => ({
    name,
    through: shown.filter((m) => m.leftOut.includes(name)).at(-1)?.period ?? "",
  }));

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
        <>
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
                · <Fig tone={toneOf(growth.pct)}>{`${growth.pct >= 0 ? "▲" : "▼"} ${growthRate(Math.abs(growth.pct)).slice(1)}`}</Fig>
              </>
            )}
          </Hero>
          <GrowthSplit saved={growth.saved} markets={growth.markets} />
        </>
      )}

      {months.length < 3 && historyStartsHere}
      <NetWorthChart months={months} window={shownWindow} onWindow={setWindow} />

      {/* The key to the line, and how to move it, in one line under it. How
          MANY months are estimated is a fact about the whole line, not a
          per-point footnote, so it rides the key. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.72rem] text-faint">
        {estimatedMonths < shown.length && (
          <span className="inline-flex items-center gap-1.5">
            <LineKey dashed={false} />
            From balances on record
          </span>
        )}
        {estimatedMonths > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <LineKey dashed />
            <span>
              Partly estimated,{" "}
              <span className="text-ink">
                {estimatedMonths} of {shown.length} month{shown.length === 1 ? "" : "s"}
              </span>
            </span>
          </span>
        )}
        <span className="md:hidden">Pinch to zoom, two fingers to move</span>
        <span className="hidden md:inline">Ctrl and scroll, or pinch, to zoom; drag to move; double-click for all</span>
      </div>
      <Note>
        Month-end, {leftOut.length === 0 ? "all accounts" : "every account with a value that month"}, from{" "}
        {shortMonthLabel(shown[0].period)} to {shortMonthLabel(shown[shown.length - 1].period)}. Tap or hover a month
        for its figures. Partly estimated means an investment account&apos;s value carried from an earlier month, its
        market movement since unseen, or a balance worked out from transactions.
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
      </Note>

      <NetWorthYears years={growthByYear(months)} />
    </CardFrame>
  );
}
