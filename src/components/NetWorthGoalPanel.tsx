"use client";

import { useRef, useState, useTransition } from "react";
import { saveNetWorthGoal } from "../app/insights/actions";
import { ACTION_DID_NOT_COMPLETE } from "../lib/ui/boundaryCopy";
import { money, monthLabel, shortDateYear } from "../lib/ui/format";
import {
  goalPath,
  NET_WORTH_HORIZON_MONTHS,
  NET_WORTH_PACE_MIN_MONTHS,
  projectGoal,
  returnToSlider,
  SLIDER_STEPS,
  sliderToReturn,
  type GoalBasis,
  type NetWorthGoalAssessment,
  type Projection,
} from "../lib/ui/netWorthGoal";
import { GoalPathChart, type GoalProjectionLine } from "./goals/GoalPathChart";
import { ASSUMED_CHIP, CHIP, FIELD_LABEL, PROJECTED_CHIP } from "./ui/headings";

const wholeDollars = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const monthsWord = (n: number) => (n === 1 ? "month" : "months");

function monthsBetween(a: string, b: string): number {
  const index = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
  return index(b) - index(a);
}

/**
 * The chart's two lines, by goalPath, the arithmetic the dates come from:
 * each runs to where it reaches the target, and a line that never does inside
 * fifty years runs to a twenty-year edge rather than squash the rest.
 */
function pathsFor(
  basis: GoalBasis,
  target: number,
  pct: number,
  savingLands: string | null,
  marketsLands: string | null,
): GoalProjectionLine[] {
  const tSave = savingLands === null ? null : monthsBetween(basis.anchor, savingLands);
  const tMarkets = pct > 0 && marketsLands !== null ? monthsBetween(basis.anchor, marketsLands) : null;
  const reach = Math.max(tSave ?? 0, tMarkets ?? 0);
  const edge = Math.min(NET_WORTH_HORIZON_MONTHS, reach > 0 ? reach + 6 : 240);
  const lines: GoalProjectionLine[] = [
    { label: "By saving alone", color: "chart1", values: goalPath(basis, undefined, tSave ?? edge), lands: tSave },
  ];
  if (pct > 0 && basis.invested !== null) {
    lines.push({
      label: `With markets at ${pct}%`,
      color: "chart2",
      values: goalPath(basis, pct, tMarkets ?? edge),
      lands: tMarkets,
    });
  }
  return lines;
}

/** "~May 2045" or the reason there is no date. */
function Landing({ p, pace }: { p: Projection; pace: number | null }) {
  if ((pace ?? 0) <= 0 && p.lands === null) return <span className="text-[0.85rem] text-faint">not reached at this pace</span>;
  if (p.lands === null) return <span className="text-[0.85rem] text-faint">more than 50 years out</span>;
  return <span className="font-money text-[1.25rem] font-semibold tabular">~{monthLabel(p.lands)}</span>;
}

function Shift({ p }: { p: Projection }) {
  if (p.lands === null || p.shift === null) return null;
  return (
    <span className="text-[0.72rem] text-faint">
      {p.shift === 0
        ? "unchanged since last month"
        : `${Math.abs(p.shift)} ${monthsWord(Math.abs(p.shift))} ${p.shift > 0 ? "later" : "sooner"} than last month`}
    </span>
  );
}

/**
 * The net worth goal, laid out as the question it answers: WHEN. The two
 * dates lead, side by side, each with its colour, which the chart beneath
 * draws (the band is the chart's legend). Then the path itself, then the two
 * numbers the operator sets. How the dates are worked out folds behind one
 * tap, but anything the reader must discount stays in view: a month whose
 * deposit did not match, rows too old to split, a pace partly estimated.
 *
 * The target and the return re-project in the browser as they move
 * (projectGoal and goalPath, the arithmetic the server ran), and each saves
 * when it settles. A shift always compares the same target and return a month
 * apart, so it says what the DATA did, never what a control did.
 */
export function NetWorthGoalPanel({ g }: { g: NetWorthGoalAssessment }) {
  const [target, setTarget] = useState(g.goal.target);
  const [draft, setDraft] = useState(wholeDollars.format(g.goal.target));
  const [pct, setPct] = useState(g.goal.realReturnPct ?? 0);
  const [setOn, setSetOn] = useState(g.goal.returnSetOn);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const saved = useRef({ target: g.goal.target, pct: g.goal.realReturnPct ?? 0 });

  const save = (next: { target: number; pct: number }) => {
    if (next.target === saved.current.target && next.pct === saved.current.pct) return;
    setFailure(null);
    startTransition(async () => {
      try {
        const result = await saveNetWorthGoal({ target: next.target, realReturnPct: next.pct });
        if (!result.ok) {
          setFailure(result.message);
          return;
        }
        saved.current = { target: result.goal.target, pct: result.goal.realReturnPct ?? 0 };
        setSetOn(result.goal.returnSetOn);
      } catch {
        // Not "retry": a lapsed sign-in fails identically (boundaryCopy.ts).
        setFailure(ACTION_DID_NOT_COMPLETE);
      }
    });
  };

  const commitTarget = () => {
    const typed = Number(draft.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(typed) || typed <= 0) {
      setFailure("The target has to be a dollar amount above zero.");
      setDraft(wholeDollars.format(target));
      return;
    }
    setTarget(typed);
    setDraft(wholeDollars.format(typed));
    save({ target: typed, pct });
  };
  const commitReturn = () => save({ target, pct });

  const reached = g.netWorth >= target;
  const progress = Math.min(1, Math.max(0, g.netWorth / target));
  const projection =
    g.basis === null || reached ? null : projectGoal(g.basis, g.previousBasis, target, pct > 0 ? pct : undefined);

  return (
    <div className="text-[0.85rem]">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="font-semibold">Net worth</span>
        <span className="font-money tabular">
          <span className="font-semibold">{money(g.netWorth)}</span>
          <span className="text-faint"> of {money(target)}</span>
        </span>
        <span className="text-faint">{Math.floor(progress * 100)}%</span>
      </div>
      <div className="mt-1.5 h-[3px] w-full rounded-[1px] bg-chip">
        <div
          className={`h-full rounded-[1px] ${reached ? "bg-pos" : "bg-acc"}`}
          style={{ width: `${Math.min(100, Math.floor(progress * 100))}%` }}
        />
      </div>

      {reached ? (
        <p className="pt-2 text-faint">
          <span className={`${CHIP} bg-pos text-paper`}>Reached</span>{" "}
          <span className="font-money tabular text-ink">{money(g.netWorth)}</span> against the{" "}
          <span className="font-money tabular">{money(target)}</span> target.
        </p>
      ) : projection === null || g.basis === null ? (
        <p className="pt-2 text-faint">
          Fewer than {NET_WORTH_PACE_MIN_MONTHS} complete months of net worth history over the same accounts, too
          few to project a date.
        </p>
      ) : (
        <>
          {/* WHEN, twice: the band is the chart's legend, each date in the
              colour of its line. */}
          <div className="mt-3 flex flex-wrap items-start gap-x-10 gap-y-3">
            <div className="grid gap-0.5">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-[9px] w-[9px] rounded-[2px] bg-chart1" />
                <span className={FIELD_LABEL}>By saving alone</span>
                <span className={PROJECTED_CHIP}>Projected</span>
              </span>
              <Landing p={projection.saving} pace={g.pace} />
              <Shift p={projection.saving} />
            </div>
            {projection.markets !== null && (
              <div className="grid gap-0.5">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="inline-block h-[9px] w-[9px] rounded-[2px] bg-chart2" />
                  <span className={FIELD_LABEL}>With markets at {pct}%</span>
                  <span className={PROJECTED_CHIP}>Projected</span>
                </span>
                <Landing p={projection.markets} pace={g.pace} />
                <Shift p={projection.markets} />
              </div>
            )}
          </div>

          <div className="mt-3">
            <GoalPathChart
              recent={g.recent}
              recentLabel="Net worth"
              anchor={g.basis.anchor}
              target={target}
              projections={pathsFor(g.basis, target, pct, projection.saving.lands, projection.markets?.lands ?? null)}
            />
          </div>
        </>
      )}

      {/* The two numbers the operator sets. Each saves when it settles: the
          target on Enter or leaving the field, the return on release. */}
      <div className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[0.78rem] text-faint">
        <label htmlFor="nw-goal-target" className={FIELD_LABEL}>
          Target
        </label>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-baseline gap-1">
            <span className="font-money">$</span>
            <input
              id="nw-goal-target"
              type="text"
              inputMode="decimal"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setFailure(null);
              }}
              onBlur={commitTarget}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTarget();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(wholeDollars.format(target));
                }
              }}
              className="tap44 w-[9.5rem] rounded-[2px] border border-rule bg-paper px-1.5 py-0.5 font-money text-[0.85rem] tabular text-ink outline-none focus:border-acc"
            />
          </span>
          <span>in today&apos;s dollars</span>
        </span>

        <label htmlFor="nw-goal-return" className={FIELD_LABEL}>
          Market return
        </label>
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <input
            id="nw-goal-return"
            type="range"
            min={0}
            max={SLIDER_STEPS}
            step={1}
            value={returnToSlider(pct)}
            list="nw-goal-return-marks"
            aria-valuetext={pct === 0 ? "no market growth" : `${pct}% a year after inflation`}
            onChange={(e) => {
              setPct(sliderToReturn(Number(e.target.value)));
              setFailure(null);
            }}
            onPointerUp={commitReturn}
            onKeyUp={commitReturn}
            onBlur={commitReturn}
            className="tap44 w-full max-w-[15rem] flex-1 accent-acc"
          />
          <datalist id="nw-goal-return-marks">
            <option value={returnToSlider(4)} />
            <option value={returnToSlider(7)} />
          </datalist>
          <span className="font-money tabular text-ink">{pct}%</span>
          {pct > 0 && <span className={ASSUMED_CHIP}>Assumed</span>}
        </span>

        <p className="col-span-2 text-[0.72rem] leading-relaxed">
          {pct === 0
            ? "No market growth assumed, so there is one date. "
            : `A year after inflation, your figure, applied to invested money only${setOn !== undefined ? `, set ${shortDateYear(new Date(`${setOn}T12:00:00Z`))}` : ""}. `}
          Forecasts for the next decade sit near 4%; US stocks returned about 7% over the last century.
          {pending && " Saving…"}
          {failure !== null && <span className="text-neg"> {failure}</span>}
        </p>
      </div>

      {/* What the reader must be able to discount stays in view. */}
      {g.unmatchedDeposit !== null && pct > 0 && (
        <p className="pt-1.5 text-[0.78rem] text-faint">
          {monthLabel(g.anchor ?? "")}&apos;s deposits came to{" "}
          <span className="font-money tabular">{money(g.unmatchedDeposit)}</span>, unlike the usual; a new amount
          counts once it repeats.
        </p>
      )}
      {pct > 0 && g.invested === null && (
        <p className="pt-1.5 text-[0.78rem] text-faint">
          The date with markets needs each account&apos;s month-end value, which the next sync records.
        </p>
      )}

      {g.basis !== null && !reached && (
        <details className="group pt-2 text-[0.78rem] text-faint">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 max-md:min-h-[44px] [&::-webkit-details-marker]:hidden">
            How these dates are worked out
            {g.paceUncertainMonths > 0 && <span>(pace partly estimated)</span>}
            <span aria-hidden="true" className="text-[0.7rem] transition-transform group-open:rotate-90">
              ›
            </span>
          </summary>
          <div className="grid gap-0.5 pt-1.5 leading-relaxed">
            <p>From the end of {monthLabel(g.anchor ?? "")}, in today&apos;s dollars.</p>
            {/* The pace a month ago sits beside today's: against a far target
                a modest change in pace moves the date by years, and a date
                that moves must say what moved it. */}
            <p>
              Saving <span className="font-money tabular text-ink">~{money(g.pace ?? 0)}</span>/mo over your last{" "}
              {g.paceMonths} complete months{g.paceUncertainMonths > 0 ? " (partly estimated)" : ""}
              {g.previousPace !== null && g.previousPace !== g.pace && (
                <>
                  , {(g.pace ?? 0) > g.previousPace ? "up" : "down"} from{" "}
                  <span className="font-money tabular">~{money(g.previousPace)}</span> a month before
                </>
              )}
              .
            </p>
            {pct > 0 && g.invested !== null && (
              <p>
                {g.contribution !== null && g.contribution > 0 ? (
                  <>
                    Investing <span className="font-money tabular text-ink">~{money(g.contribution)}</span>/mo, your
                    usual deposit over the last three months
                    {g.previousContribution !== null && g.previousContribution !== g.contribution && (
                      <>
                        , {g.contribution > g.previousContribution ? "up" : "down"} from{" "}
                        <span className="font-money tabular">~{money(g.previousContribution)}</span> a month before
                      </>
                    )}
                    . That and the <span className="font-money tabular">{money(g.invested)}</span> invested earn the
                    return; the rest of what you save is counted as cash.
                  </>
                ) : (
                  <>
                    No regular monthly investing over your last three months, so new savings are counted as cash; the
                    return applies to the <span className="font-money tabular">{money(g.invested)}</span> invested.
                  </>
                )}
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
