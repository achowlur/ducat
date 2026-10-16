"use client";

import { useRef, useState, useTransition } from "react";
import { saveNetWorthGoal } from "../app/insights/actions";
import { ACTION_DID_NOT_COMPLETE } from "../lib/ui/boundaryCopy";
import { money, monthLabel, shortDateYear } from "../lib/ui/format";
import {
  NET_WORTH_PACE_MIN_MONTHS,
  projectGoal,
  type NetWorthGoalAssessment,
  type Projection,
} from "../lib/ui/netWorthGoal";
import { ASSUMED_CHIP, CHIP, FIELD_LABEL, PROJECTED_CHIP } from "./ui/headings";

/** The slider's right end: ten percent a year after inflation is already past a century of US stocks. */
const RETURN_MAX = 10;
/** Half a point: finer than any forecast can honestly claim. */
const RETURN_STEP = 0.5;

const wholeDollars = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const monthsWord = (n: number) => (n === 1 ? "month" : "months");

/**
 * The net worth goal: live progress, then TWO dates, never one blended rate.
 * By saving alone is observed; with markets adds a return the operator SET,
 * so it wears ASSUMED beside PROJECTED and keeps its as-of day in view.
 *
 * The target and the return are controls, not command-line values: the dates
 * re-project in the browser as they move (projectGoal, the arithmetic the
 * server ran), and each saves when it settles, the slider on release rather
 * than every step of a drag. A refusal is shown beside the controls. The
 * shifts always compare the same target and return a month apart, so they
 * say what the DATA did, never what a control did. A return of zero is "no
 * market growth assumed": the slider starts there when none is set, because
 * no return lives in code.
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

  const shiftText = (p: Projection) =>
    p.shift === null
      ? "."
      : p.shift === 0
        ? ", unchanged since last month."
        : `, ${Math.abs(p.shift)} ${monthsWord(Math.abs(p.shift))} ${p.shift > 0 ? "later" : "sooner"} than last month.`;
  const landsText = (p: Projection) =>
    p.lands === null ? (
      " more than 50 years out at this pace."
    ) : (
      <>
        {" "}
        <span className="font-semibold">~{monthLabel(p.lands)}</span>
        {shiftText(p)}
      </>
    );

  return (
    <div className="py-2.5 text-[0.85rem] max-md:py-3">
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
      <div className="pt-1 leading-relaxed text-faint">
        {reached ? (
          <>
            <span className={`${CHIP} bg-pos text-paper`}>Reached</span>{" "}
            <span className="font-money tabular text-ink">{money(g.netWorth)}</span> against the{" "}
            <span className="font-money tabular">{money(target)}</span> target.
          </>
        ) : projection === null ? (
          `Fewer than ${NET_WORTH_PACE_MIN_MONTHS} complete months of net worth history over the same accounts, too few to project a date.`
        ) : (
          <>
            <p>
              <span className={PROJECTED_CHIP}>Projected</span>{" "}
              <span className="text-ink">
                By saving alone,
                {(g.pace ?? 0) <= 0
                  ? " not reached: the saved part of your net worth did not grow."
                  : landsText(projection.saving)}
              </span>
            </p>
            {projection.markets !== null && (
              <p className="pt-0.5">
                <span className={PROJECTED_CHIP}>Projected</span>{" "}
                <span className="text-ink">
                  With markets at {pct}% a year after inflation,
                  {landsText(projection.markets)}
                </span>
              </p>
            )}
            {pct > 0 && g.invested === null && (
              <p className="pt-0.5">
                The date with markets needs each account&apos;s month-end value, which the next sync records.
              </p>
            )}
            <p className="pt-0.5">From the end of {monthLabel(g.anchor ?? "")}, in today&apos;s dollars.</p>
            {/* The pace a month ago sits beside today's: against a far target
                a modest change in pace moves the date by years, and a date
                that moves must say what moved it. */}
            <p className="pt-0.5">
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
            {g.invested !== null && projection.markets !== null && (
              // What compounds, said in full: the balance, plus the monthly
              // deposit (the middle of the last three months, so a new amount
              // counts once it repeats and a lump sum never does); everything
              // else saved is counted as cash. A deposit that changed says
              // what it was, and one that does not match yet says so: it
              // never changes silently.
              <>
                <p className="pt-0.5">
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
                      No regular monthly investing over your last three months, so new savings are counted as cash;
                      the return applies to the <span className="font-money tabular">{money(g.invested)}</span>{" "}
                      invested.
                    </>
                  )}
                </p>
                {g.unmatchedDeposit !== null && (
                  <p className="pt-0.5">
                    {monthLabel(g.anchor ?? "")}&apos;s deposits came to{" "}
                    <span className="font-money tabular">{money(g.unmatchedDeposit)}</span>, unlike the usual; a new
                    amount counts once it repeats.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* The two numbers the operator sets. Each saves when it settles: the
          target on Enter or leaving the field, the return on release. */}
      <div className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 border-t border-rule pt-2.5 text-[0.78rem] text-faint">
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
            max={RETURN_MAX}
            step={RETURN_STEP}
            value={pct}
            list="nw-goal-return-marks"
            aria-valuetext={pct === 0 ? "no market growth" : `${pct}% a year after inflation`}
            onChange={(e) => {
              setPct(Number(e.target.value));
              setFailure(null);
            }}
            onPointerUp={commitReturn}
            onKeyUp={commitReturn}
            onBlur={commitReturn}
            className="tap44 w-full max-w-[15rem] flex-1 accent-acc"
          />
          {/* Tick marks where the evidence sits: the decade's forecasts and
              a century of history. */}
          <datalist id="nw-goal-return-marks">
            <option value="4" />
            <option value="7" />
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
    </div>
  );
}
