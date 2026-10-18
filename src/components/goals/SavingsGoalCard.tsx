"use client";

import { GOAL_RATE_MIN_MONTHS, type GoalAssessment } from "../../lib/insights/goals";
import type { RecentMonths } from "../../lib/insights/recentMonths";
import { money, monthLabel } from "../../lib/ui/format";
import { recordThroughToday } from "../../lib/ui/goalFunds";
import { droppedNote, shortNote, windowSpan } from "../../lib/ui/recentMonthsNote";
import { CHIP, FIELD_LABEL, PROJECTED_CHIP } from "../ui/headings";
import { GoalPathChart, type GoalProjectionLine } from "./GoalPathChart";

const monthsWord = (n: number) => (n === 1 ? "month" : "months");

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
  const lands = g.landsMonth === null ? null : Math.max(0, monthsBetween(anchor, g.landsMonth));
  const rate = g.monthlyRate ?? 0;
  const projections: GoalProjectionLine[] =
    g.refusal === null && !g.reached && rate > 0
      ? [
          {
            label: "At your saving pace",
            color: "chart1",
            values: Array.from({ length: (lands ?? 240) + 1 }, (_, t) => Math.min(g.goal.target, g.saved + rate * t)),
            lands,
          },
        ]
      : [];

  // The date leads when there is one: the name, then WHEN, then how far along.
  const showsWhen = !g.reached && g.refusal === null;
  const whenBlock = (
    <div className="mt-1.5 grid gap-0.5">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-[9px] w-[9px] rounded-[2px] bg-chart1" />
        <span className={FIELD_LABEL}>At your saving pace</span>
        <span className={PROJECTED_CHIP}>Projected</span>
      </span>
      {(g.monthsToTarget ?? 0) > 600 ? (
        <span className="text-[0.85rem] text-faint">more than 50 years out</span>
      ) : (
        <span className="font-money text-[1.25rem] font-semibold tabular">~{monthLabel(g.landsMonth ?? "")}</span>
      )}
      {g.deltaMonths !== null && g.goal.targetMonth !== undefined && (
        <span className="text-[0.72rem] text-faint">
          {g.deltaMonths === 0
            ? `on target for ${monthLabel(g.goal.targetMonth)}`
            : `${Math.abs(g.deltaMonths)} ${monthsWord(Math.abs(g.deltaMonths))} ${g.deltaMonths < 0 ? "ahead of" : "behind"} ${monthLabel(g.goal.targetMonth)}`}
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
      ) : g.refusal === "RATE_NOT_POSITIVE" ? (
        <p className="pt-2 text-faint">
          Averaged over {span} you are not saving (
          <span className="font-money tabular">{money(g.monthlyRate ?? 0)}</span>/mo net), so there is no landing date
          worth printing.
        </p>
      ) : (
        <>
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
          {/* The reconciliation stays beside the date: the pace assumes every
              saved dollar reaches this fund, and this is the observation that
              says whether it did. */}
          {g.observedFundGrowth !== null && (
            <p className="pt-1.5 text-[0.78rem] text-faint">
              Your cash {g.observedFundGrowth < 0 ? "shrank" : "grew"}{" "}
              <span className="font-money tabular text-ink">~{money(Math.abs(g.observedFundGrowth))}</span>/mo,{" "}
              {g.observedFundGrowth < rate ? "not" : "at least"} the{" "}
              <span className="font-money tabular">~{money(rate)}</span>/mo this date assumes.
            </p>
          )}
          {/* A month short an account is something to discount, so it stays in view. */}
          {leans !== null && <p className="pt-1 text-[0.78rem] text-faint">{leans}</p>}
          <details className="group pt-2 text-[0.78rem] text-faint">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 max-md:min-h-[44px] [&::-webkit-details-marker]:hidden">
              How this date is worked out
              <span aria-hidden="true" className="text-[0.7rem] transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>
            <p className="pt-1.5 leading-relaxed">
              From your balance today: saving{" "}
              <span className="font-money tabular text-ink">~{money(rate)}</span>/mo, your income less spending averaged
              over {span}, one-off income such as a bonus or a refund left out.{left !== null && ` ${left}`}
            </p>
          </details>
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
