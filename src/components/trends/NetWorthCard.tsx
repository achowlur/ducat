"use client";

import { useState } from "react";
import { clampWindow, fullWindow, isFull, MIN_DAY_SPAN, MIN_SPAN, shownMonths, type ChartWindow } from "../../lib/ui/chartZoom";
import { CARRY_DAYS, dayLabel, type DailyNetWorth } from "../../lib/ui/dailyNetWorth";
import { money, shortMonthLabel } from "../../lib/ui/format";
import { growthBetween, growthByYear } from "../../lib/ui/netWorthGrowth";
import { NetWorthChart } from "../charts/NetWorthChart";
import { CardFrame, Fig, Fold, Hero, Lead, Note } from "./CardFrame";
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
  daily,
  spendingFrom,
}: {
  months: NetWorthMonth[];
  /** Day by day where every account has a balance: what the line zooms into past three months. */
  daily: DailyNetWorth;
  /** The first month of the spending history, for the note when this line is shorter. */
  spendingFrom: string | null;
}) {
  const days = daily.points;
  const [mode, setMode] = useState<"month" | "day">("month");
  const [monthWindow, setMonthWindow] = useState<ChartWindow>(() => fullWindow(months.length));
  const [dayWindow, setDayWindow] = useState<ChartWindow>(() => fullWindow(days.length));
  // A new history (a statement import, a sync) resets the zoom rather than
  // holding a window measured against the old one.
  const [anchorCount, setAnchorCount] = useState(`${months.length}/${days.length}`);
  if (anchorCount !== `${months.length}/${days.length}`) {
    setAnchorCount(`${months.length}/${days.length}`);
    setMode("month");
    setMonthWindow(fullWindow(months.length));
    setDayWindow(fullWindow(days.length));
  }
  const showAll = () => {
    setMode("month");
    setMonthWindow(fullWindow(months.length));
  };

  // Zoomed in past three months where days are on record, the line goes on
  // into days: the months on show become the days between their month-ends
  // (through today when the newest month is among them). Zoomed out past all
  // of the days, it comes back to its last three months.
  const hasDays = days.length > MIN_DAY_SPAN;
  const drillIn = (anchor: number): boolean => {
    if (!hasDays) return false;
    const { first, last } = shownMonths(monthWindow);
    const at = Math.round(monthWindow.start + anchor * (monthWindow.end - monthWindow.start));
    // The month under the pointer must be one the days reach.
    if (months[at] === undefined || months[at].period < days[0].period.slice(0, 7)) return false;
    const fromKey = `${months[first].period}-31`;
    const toKey = last === months.length - 1 ? "9999-12-31" : `${months[last].period}-31`;
    const start = Math.max(0, days.findIndex((d) => d.period > fromKey));
    const end = Math.max(start, days.findLastIndex((d) => d.period <= toKey));
    setDayWindow(clampWindow({ start, end }, days.length, MIN_DAY_SPAN));
    setMode("day");
    return true;
  };
  const drillOut = (): boolean => {
    setMode("month");
    setMonthWindow(clampWindow({ start: months.length - 1 - MIN_SPAN, end: months.length - 1 }, months.length));
    return true;
  };
  const inDays = mode === "day" && hasDays;
  const points = inDays ? days : months;
  const shownWindow = inDays ? dayWindow : monthWindow;
  const setWindow = inDays ? setDayWindow : setMonthWindow;
  const label = inDays ? dayLabel : shortMonthLabel;

  const historyStartsHere = (
    <div className="mb-3 border-l-2 border-warn bg-chip/50 px-2.5 py-1.5 text-[0.75rem] text-faint">
      <p>
        <span className="font-semibold text-acc">History starts here.</span> A month appears once an account has a
        value in it, and each sync adds one, so this line grows from today forward.
      </p>
      <Fold label="Why it starts here">
        <p className="mt-1">
          Imported transactions can&apos;t give a brokerage a value: it moves with the market, which leaves no
          transaction to reconstruct from. Statement imports and month-end balances supply earlier months.
        </p>
      </Fold>
    </div>
  );

  // Analyzers legitimately emit nothing: no month has a value yet.
  if (months.length === 0) {
    return (
      <CardFrame id="net-worth" title="Net worth" switcher={null}>
        {historyStartsHere}
        <NetWorthChart months={[]} window={monthWindow} onWindow={setMonthWindow} />
      </CardFrame>
    );
  }

  const zoomed = inDays || !isFull(shownWindow, months.length);
  const { first, last } = shownMonths(shownWindow);
  const shown: (NetWorthMonth | (typeof days)[number])[] = points.slice(first, last + 1);
  const growth = last > first ? growthBetween(points, first, last) : null;
  // Days the daily line leaves out inside what is on show.
  const missingShown = inDays ? daily.missing.filter((d) => d > shown[0].period && d < shown[shown.length - 1].period) : [];
  const estimatedMonths = shown.filter((m) => m.estimated).length;
  // Each account a shown month leaves out, with the LAST month it is missing from.
  const leftOut = [...new Set(shown.flatMap((m) => m.leftOut))].map((name) => ({
    name,
    through: shown.filter((m) => m.leftOut.includes(name)).at(-1)?.period ?? "",
  }));

  const reset = zoomed ? (
    <button
      type="button"
      onClick={showAll}
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
              {label(growth.from)} to {label(growth.to)}
            </Lead>
            {/* From the first month on record the base is wherever the records
                happen to begin, often a near-empty first account, so its ratio
                describes the records, not the growth. Zoomed past it, the base
                is a real month-end. */}
            {growth.pct !== null && (inDays || first > 0) && (
              <>
                {" "}
                · <Fig tone={toneOf(growth.pct)}>{`${growth.pct >= 0 ? "▲" : "▼"} ${growthRate(Math.abs(growth.pct)).slice(1)}`}</Fig>
              </>
            )}
          </Hero>
          <GrowthSplit saved={growth.saved} markets={growth.markets} joined={growth.joined} />
        </>
      )}

      {months.length < 3 && historyStartsHere}
      <NetWorthChart
        months={points}
        window={shownWindow}
        onWindow={setWindow}
        scale={
          inDays
            ? { unit: "day", minSpan: MIN_DAY_SPAN, drillOut, onAll: showAll }
            : { unit: "month", minSpan: MIN_SPAN, drillIn, onAll: showAll }
        }
      />

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
                {estimatedMonths} of {shown.length} {inDays ? "day" : "month"}
                {shown.length === 1 ? "" : "s"}
              </span>
            </span>
          </span>
        )}
        <span className="md:hidden">Pinch to zoom, two fingers to move</span>
        <span className="hidden md:inline">Ctrl and scroll, or pinch, to zoom; drag to move; double-click for all</span>
        {/* Where the days begin, said once: zooming past three months is
            otherwise a limit nobody would push on. */}
        {hasDays &&
          (inDays ? (
            <span className="text-ink">Day by day; zoom out for months</span>
          ) : (
            <span className="text-ink">Day by day from {dayLabel(days[0].period)}: zoom in past three months</span>
          ))}
      </div>
      {/* What a reader must discount stays in view: an account a month leaves
          out (a month missing one is SMALLER than the truth, named in text with
          the last month it is missing from), and a line shorter than the
          history above it. How the line is worked out is behind a tap. */}
      {(leftOut.length > 0 || missingShown.length > 0 || (!zoomed && spendingFrom !== null && months[0].period > spendingFrom)) && (
        <Note>
          {missingShown.length > 0 && (
            <span className="text-ink">
              Left out: {missingShown.map(dayLabel).join(", ")}, where an account&apos;s newest balance was over{" "}
              {CARRY_DAYS} days old.{" "}
            </span>
          )}
          {leftOut.length > 0 && (
            <span className="text-ink">
              Left out where it has no value yet:{" "}
              {leftOut.map((l) => `${l.name} (through ${label(l.through)})`).join(", ")}.
            </span>
          )}
          {!zoomed && spendingFrom !== null && months[0].period > spendingFrom && (
            <> Shorter than the spending history above: a month appears once some account has a value in it.</>
          )}
        </Note>
      )}
      <Fold label="How this line is worked out">
        {inDays ? (
          <Note>
            Each day, every account&apos;s balance as its bank last reported it, from {dayLabel(shown[0].period)} to{" "}
            {dayLabel(shown[shown.length - 1].period)}. A bank that posts no new balance for a day (a weekend, a
            holiday) counts at its last one for up to {CARRY_DAYS} days; past that the day is left out. Markets is the
            investment accounts&apos; change less money moved in or out, counted on the day their balance shows it.
            Tap a day for its figures.
          </Note>
        ) : (
          <Note>
            Month-end, {leftOut.length === 0 ? "all accounts" : "every account with a value that month"}, from{" "}
            {shortMonthLabel(shown[0].period)} to {shortMonthLabel(shown[shown.length - 1].period)}. Tap a month for
            its figures. Partly estimated means an investment account&apos;s value carried from an earlier month, its
            market movement since unseen, or a balance worked out from transactions.
          </Note>
        )}
      </Fold>

      <NetWorthYears years={growthByYear(months)} />
    </CardFrame>
  );
}
