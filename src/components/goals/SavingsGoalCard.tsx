"use client";

import { useRef, useState, useTransition } from "react";
import { saveSavingsGoalPace } from "../../app/insights/actions";
import {
  extraToLand,
  GOAL_RATE_MIN_MONTHS,
  monthsAfterTarget,
  projectLanding,
  type GoalAssessment,
} from "../../lib/insights/goals";
import type { RecentMonths } from "../../lib/insights/recentMonths";
import { ACTION_DID_NOT_COMPLETE } from "../../lib/ui/boundaryCopy";
import { money, monthLabel } from "../../lib/ui/format";
import { recordThroughToday } from "../../lib/ui/goalFunds";
import { droppedNote, shortNote, windowSpan } from "../../lib/ui/recentMonthsNote";
import { ActionAlert } from "../ActionAlert";
import { ASSUMED_CHIP, CHIP, CONTROL, FIELD_LABEL, PROJECTED_CHIP } from "../ui/headings";
import { GoalPathChart, type GoalProjectionLine } from "./GoalPathChart";
import { PaceField } from "./PaceField";

const monthsWord = (n: number) => (n === 1 ? "month" : "months");

const roughly = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** The same amount within a cent or 2%, as the net worth goal judges a typed figure equal to the measured one. */
const sameAmount = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, 0.02 * Math.max(Math.abs(a), Math.abs(b)));

function monthsBetween(a: string, b: string): number {
  const index = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
  return index(b) - index(a);
}

/**
 * A savings goal in the net worth goal's shape: progress, then WHEN as the
 * headline with how it stands against the month the operator aimed for, then
 * the fund's path (its record, and the projection at the saving pace). The
 * pace folds behind one tap; what the reader must discount does not: a cash
 * goal's RECONCILIATION (cash's own growth over the same window, which says
 * whether the full pace really reaches the fund) stays in view beside the
 * date, as goals-and-insights.md requires, and so does an account that no
 * longer exists. Every refusal renders, and progress survives all of them.
 *
 * "Saved per month" is the card's one control, as on the net worth goal: it
 * starts as the measured pace, the date and the path re-project as it is
 * typed (projectLanding, the arithmetic the server ran, from the same
 * instant), and it saves to the goal when it settles. A goal that lands AFTER
 * its target month gets an ActionAlert under the path with the field inside
 * it, pre-filled with the pace that lands on time; otherwise the field sits
 * in the controls. Typing the measured figure clears it.
 */
export function SavingsGoalCard({
  g,
  history,
  anchor,
  window,
}: {
  g: GoalAssessment;
  /** The fund at past month-ends, oldest first. */
  history: { period: string; value: number }[];
  /** The month being lived in: the projection starts here, from the live balance. */
  anchor: string;
  /** The months the pace averages: those left out, and those still short an account. */
  window: RecentMonths | null;
}) {
  const span = window === null ? `your last ${g.basisMonths} complete ${monthsWord(g.basisMonths)}` : windowSpan(window);
  const left = window === null ? null : droppedNote(window);
  // Months short an account read cheaper than they were, so the pace leans high.
  const leans = window === null ? null : shortNote(window, "the pace may run high");

  const [paceSet, setPaceSet] = useState<number | null>(g.paceSet);
  const [typing, setTyping] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const stored = useRef<number | null>(g.paceSet);
  const measured = g.measuredRate;
  const canSet = !g.reached && g.refusal !== "NO_ACCOUNTS" && measured !== null;
  // The pace the saved settings project at, and the one on screen while typing.
  const committed = paceSet ?? measured ?? 0;
  const rate = typing ?? committed;
  const live = canSet ? projectLanding(g.remaining, rate, g.nowMs) : null;
  const liveDelta = live === null ? null : monthsAfterTarget(live.landsMonth, g.goal.targetMonth);
  const lands = live === null ? null : Math.max(0, monthsBetween(anchor, live.landsMonth));
  const projections: GoalProjectionLine[] =
    live !== null
      ? [
          {
            label: "At your saving pace",
            color: "chart1",
            values: Array.from({ length: (lands ?? 240) + 1 }, (_, t) => Math.min(g.goal.target, g.saved + rate * t)),
            lands,
          },
        ]
      : [];

  // What the SAVED pace asks to land by the target month, when it lands after.
  const shortfall = canSet
    ? extraToLand({ remaining: g.remaining, rate: committed, targetMonth: g.goal.targetMonth, nowMs: g.nowMs })
    : null;
  const suggested = shortfall === null ? null : Math.round(committed + shortfall.extra);
  const fieldValue = paceSet ?? suggested ?? measured ?? 0;

  const save = (next: number | null) => {
    const before = stored.current;
    startTransition(async () => {
      try {
        const result = await saveSavingsGoalPace({ id: g.goal.id, monthlyPace: next });
        if (!result.ok) {
          setFailure(result.message);
          setPaceSet(before);
          return;
        }
        stored.current = next;
      } catch {
        // Not "retry": a lapsed sign-in fails identically (boundaryCopy.ts).
        setFailure(ACTION_DID_NOT_COMPLETE);
        setPaceSet(before);
      }
    });
  };
  const commitPace = (typed: number | null) => {
    if (typed === null) {
      setFailure("The monthly saving has to be a dollar amount.");
      return false;
    }
    // The measured figure, typed back, follows the data again.
    const next = measured !== null && sameAmount(typed, measured) ? null : typed;
    setTyping(null);
    setFailure(null);
    if (next === stored.current) return true;
    setPaceSet(next);
    save(next);
    return true;
  };
  const useMeasured = () => {
    setTyping(null);
    setFailure(null);
    if (stored.current === null) return;
    setPaceSet(null);
    save(null);
  };
  const paceId = `savings-pace-${g.goal.id}`;
  const paceField = (
    <PaceField
      key={`pace:${fieldValue}`}
      id={paceId}
      value={fieldValue}
      onDraft={(typed) => {
        setFailure(null);
        setTyping(typed);
      }}
      onCommit={commitPace}
    />
  );
  const useUsual =
    paceSet !== null && measured !== null ? (
      <button
        type="button"
        onClick={useMeasured}
        className={`${CONTROL} tap44 border-rule text-faint hover:border-acc hover:text-acc`}
      >
        Use usual, <span className="font-money tabular">{roughly.format(measured)}</span>
      </button>
    ) : null;

  // The date leads when there is one: the name, then WHEN, then how far along.
  const showsWhen = live !== null;
  const whenBlock = (
    <div className="mt-1.5 grid gap-0.5">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-[9px] w-[9px] rounded-[2px] bg-chart1" />
        <span className={FIELD_LABEL}>At your saving pace</span>
        <span className={PROJECTED_CHIP}>Projected</span>
      </span>
      {(live?.monthsToTarget ?? 0) > 600 ? (
        <span className="text-[0.85rem] text-faint">more than 50 years out</span>
      ) : (
        <span className="font-money text-[1.25rem] font-semibold tabular">~{monthLabel(live?.landsMonth ?? "")}</span>
      )}
      {liveDelta !== null && g.goal.targetMonth !== undefined && (
        <span className="text-[0.72rem] text-faint">
          {liveDelta === 0
            ? `on target for ${monthLabel(g.goal.targetMonth)}`
            : `${Math.abs(liveDelta)} ${monthsWord(Math.abs(liveDelta))} ${liveDelta < 0 ? "ahead of" : "behind"} ${monthLabel(g.goal.targetMonth)}`}
        </span>
      )}
    </div>
  );

  return (
    <div className="text-[0.85rem]">
      {showsWhen && (
        <>
          <div className="font-semibold">{g.goal.name}</div>
          {whenBlock}
        </>
      )}
      <div className={`flex flex-wrap items-baseline gap-x-2.5 gap-y-1 ${showsWhen ? "pt-2" : ""}`}>
        {!showsWhen && <span className="font-semibold">{g.goal.name}</span>}
        <span className="font-money tabular">
          <span className="font-semibold">{money(g.saved)}</span>
          <span className="text-faint"> of {money(g.goal.target)}</span>
        </span>
        <span className="text-faint">{Math.floor(g.progress * 100)}%</span>
      </div>
      {g.accountNames.length > 0 && (
        <div className="pt-0.5 text-[0.72rem] text-faint">
          {g.accountNames.join(" + ")}
          {/* A cash fund is cash after the cards it pays: said beside the accounts. */}
          {g.goal.cash === true && (g.cardsOwed > 0 ? `, less ${money(g.cardsOwed)} on cards` : ", nothing owed on cards")}
        </div>
      )}
      <div className="mt-1.5 h-[3px] w-full rounded-[1px] bg-chip">
        <div
          className={`h-full rounded-[1px] ${g.reached ? "bg-pos" : "bg-acc"}`}
          style={{ width: `${Math.min(100, Math.floor(g.progress * 100))}%` }}
        />
      </div>

      {g.reached ? (
        <p className="pt-2 text-faint">
          <span className={`${CHIP} bg-pos text-paper`}>Reached</span>{" "}
          <span className="font-money tabular text-ink">{money(g.saved)}</span> against the{" "}
          <span className="font-money tabular">{money(g.goal.target)}</span> target.
        </p>
      ) : g.refusal === "NO_ACCOUNTS" ? (
        <p className="pt-2 text-faint">
          {g.goal.cash === true ? (
            <>
              Nothing counts as cash right now. Declare cash accounts with{" "}
              <span className="font-money">npm run accounts:cash</span>.
            </>
          ) : (
            <>
              None of the accounts this goal nominates exist any more. Re-point it with{" "}
              <span className="font-money">npm run goals</span>.
            </>
          )}
        </p>
      ) : g.refusal === "TOO_FEW_MONTHS" ? (
        <p className="pt-2 text-faint">
          {g.basisMonths === 0
            ? "No complete months of cash-flow history yet, so there is nothing to project a landing date from."
            : `Only ${g.basisMonths} complete ${monthsWord(g.basisMonths)} of cash-flow history to compare, too few to project a landing date (${GOAL_RATE_MIN_MONTHS} needed).`}
          {left !== null && ` ${left}`}
        </p>
      ) : (
        <>
          {live === null && (
            <p className="pt-2 text-faint">
              {paceSet === null ? (
                <>
                  Averaged over {span} you are not saving (
                  <span className="font-money tabular">{money(measured ?? 0)}</span>/mo net), so there is no landing
                  date worth printing.
                </>
              ) : (
                <>
                  At the <span className="font-money tabular">{money(committed)}</span>/mo you set there is no landing
                  date worth printing.
                </>
              )}
            </p>
          )}
          {projections.length > 0 && (
            <div className="mt-3">
              <GoalPathChart
                recent={recordThroughToday(history, anchor, g.saved)}
                recentLabel={g.goal.name}
                anchor={anchor}
                target={g.goal.target}
                projections={projections}
              />
            </div>
          )}
          {/* BEHIND: the one line that asks for an action, with the action in
              it. The field is the same "Saved per month" the controls hold when
              the goal is on time, so it is never in two places. */}
          {shortfall !== null && g.goal.targetMonth !== undefined ? (
            <div className="mt-3">
              <ActionAlert
                kind="Behind"
                detail={`${g.goal.name}, target ${monthLabel(g.goal.targetMonth)}`}
                actions={
                  // ActionAlert's actions never wrap under its text, so on a phone this
                  // block takes the row's full width (page gutters 24px, alert padding 12px)
                  // and lands on a line of its own.
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 max-md:w-[calc(100vw-4.5rem)]">
                    <label htmlFor={paceId} className={FIELD_LABEL}>
                      Saved per month
                    </label>
                    {paceField}
                    {useUsual}
                  </div>
                }
              >
                Save ~{roughly.format(shortfall.extra)}/mo more to land on time
              </ActionAlert>
            </div>
          ) : (
            canSet && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78rem] text-faint">
                <label htmlFor={paceId} className={FIELD_LABEL}>
                  Saved per month
                </label>
                {paceField}
                {paceSet === null ? (
                  <span>{g.basisMonths}-month average</span>
                ) : (
                  <>
                    <span className={ASSUMED_CHIP}>Assumed</span>
                    {useUsual}
                  </>
                )}
              </div>
            )
          )}
          {failure !== null && <p className="pt-1 text-[0.78rem] text-neg">{failure}</p>}
          {/* The reconciliation stays beside the date: the pace assumes every
              saved dollar reaches this fund, and this is the observation that
              says whether it did. */}
          {g.observedFundGrowth !== null && live !== null && (
            <p className="pt-1.5 text-[0.78rem] text-faint">
              Your cash {g.observedFundGrowth < 0 ? "shrank" : "grew"}{" "}
              <span className="font-money tabular text-ink">~{money(Math.abs(g.observedFundGrowth))}</span>/mo,{" "}
              {g.observedFundGrowth < rate ? "not" : "at least"} the{" "}
              <span className="font-money tabular">~{money(rate)}</span>/mo this date assumes.
            </p>
          )}
          {/* A month short an account is something to discount, so it stays in view. */}
          {leans !== null && <p className="pt-1 text-[0.78rem] text-faint">{leans}</p>}
          {live !== null && (
            <details className="group pt-2 text-[0.78rem] text-faint">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 max-md:min-h-[44px] [&::-webkit-details-marker]:hidden">
                How this date is worked out
                <span aria-hidden="true" className="text-[0.7rem] transition-transform group-open:rotate-90">
                  ›
                </span>
              </summary>
              <p className="pt-1.5 leading-relaxed">
                From your balance today: saving{" "}
                <span className="font-money tabular text-ink">~{money(rate)}</span>/mo,{" "}
                {paceSet === null ? (
                  <>your income less spending averaged over {span}, one-off income such as a bonus or a refund left out.</>
                ) : (
                  <>
                    the pace you set. Averaged over {span} it is{" "}
                    <span className="font-money tabular">~{money(measured ?? 0)}</span>/mo, one-off income such as a
                    bonus or a refund left out.
                  </>
                )}
                {left !== null && ` ${left}`}
              </p>
            </details>
          )}
        </>
      )}
      {g.missingAccounts > 0 && g.refusal !== "NO_ACCOUNTS" && (
        <p className="pt-1.5 text-[0.78rem] text-neg">
          {g.missingAccounts} nominated {g.missingAccounts === 1 ? "account" : "accounts"} no longer{" "}
          {g.missingAccounts === 1 ? "exists" : "exist"}, so saved is understated.
        </p>
      )}
    </div>
  );
}
