"use client";

import { useRef, useState, useTransition } from "react";
import { confirmNewPay, saveNetWorthGoal } from "../app/insights/actions";
import { ACTION_DID_NOT_COMPLETE } from "../lib/ui/boundaryCopy";
import { money, monthLabel, shortDateYear, titleCase } from "../lib/ui/format";
import { wholePercents } from "../lib/ui/spendingBreakdown";
import {
  ASSUMED_INFLATION_PCT,
  goalPath,
  keepingUp,
  NET_WORTH_HORIZON_MONTHS,
  NET_WORTH_PACE_MIN_MONTHS,
  NET_WORTH_PACE_MONTHS,
  projectGoal,
  returnToSlider,
  SLIDER_STEPS,
  sliderToReturn,
  withCashMoved,
  withSaving,
  type GoalBasis,
  type NetWorthGoalAssessment,
  type Projection,
  type SavingOverrides,
} from "../lib/ui/netWorthGoal";
import { GoalPathChart, type GoalProjectionLine } from "./goals/GoalPathChart";
import { ASSUMED_CHIP, CHIP, CONTROL, FIELD_LABEL, PROJECTED_CHIP } from "./ui/headings";

const wholeDollars = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
// An estimate in whole dollars: cents on a figure grown by an assumed rate claim a precision it lacks.
const roughly = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const percent = (n: number) => `${n.toFixed(1).replace(/\.0$/, "")}%`;
const monthsWord = (n: number) => (n === 1 ? "month" : "months");

// A control's label sits beside it from md up and above it on a phone, where
// a control that wraps to three lines left its label floating between them.
const LABEL = `${FIELD_LABEL} max-md:pt-2`;

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

/** The same amount within a cent or 2%, as a deposit is judged to match (netWorthGoal.ts). */
const sameAmount = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, 0.02 * Math.max(Math.abs(a), Math.abs(b)));

/** What the panel's controls hold; a null monthly figure follows the data. */
type Draft = { target: number; pct: number; invest: number | null; pace: number | null };

const FIELD =
  "tap44 w-[9.5rem] rounded-[2px] border border-rule bg-paper px-1.5 py-0.5 font-money text-[0.85rem] tabular text-ink outline-none focus:border-acc";

/**
 * A dollar field: commits on Enter or on leaving it, puts back what it showed
 * on Escape or a refused value. The caller keys it by the value it shows, so
 * a figure moved elsewhere (the saving, when the investing moves it) redraws.
 */
function AmountInput({
  id,
  value,
  negative = false,
  onEdit,
  onCommit,
}: {
  id: string;
  value: number;
  negative?: boolean;
  onEdit: () => void;
  /** False refuses the value and puts back the one shown. */
  onCommit: (typed: number | null) => boolean;
}) {
  const [draft, setDraft] = useState(wholeDollars.format(value));
  const commit = () => {
    const cleaned = draft.replace(negative ? /[^0-9.-]/g : /[^0-9.]/g, "");
    const typed = Number(cleaned);
    const ok = onCommit(cleaned === "" || cleaned === "-" || !Number.isFinite(typed) ? null : typed);
    setDraft(wholeDollars.format(ok && Number.isFinite(typed) && cleaned !== "" ? typed : value));
  };
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-money">$</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          onEdit();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(wholeDollars.format(value));
          }
        }}
        className={FIELD}
      />
    </span>
  );
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
 * The target, the return and the monthly amount invested re-project in the
 * browser as they move (projectGoal and goalPath, the arithmetic the server
 * ran), and each saves when it settles. A shift always compares the same
 * target, return and amount a month apart, so it says what the DATA did,
 * never what a control did.
 *
 * The two monthly figures start as the measured ones (the saving pace over
 * the last six months, the deposit as the middle of the last three) and
 * follow the data while untouched; one typed in place holds until it is set
 * back, and typing the measured figure sets it back.
 *
 * The dates are in today's dollars, which assume the saving rises with
 * inflation. The note under the controls says what that asks at an assumed
 * 3% a year, and the deposit is checked against a year ago: kept level in
 * dollars, it falls behind (keepingUp).
 */
export function NetWorthGoalPanel({ g }: { g: NetWorthGoalAssessment }) {
  const [target, setTarget] = useState(g.goal.target);
  const [pct, setPct] = useState(g.goal.realReturnPct ?? 0);
  const [setOn, setSetOn] = useState(g.goal.returnSetOn);
  // Figures typed in place of the measured ones; null follows the data.
  const [invest, setInvest] = useState<number | null>(g.goal.monthlyInvest ?? null);
  const [paceSet, setPaceSet] = useState<number | null>(g.goal.monthlyPace ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const saved = useRef<Draft>({
    target: g.goal.target,
    pct: g.goal.realReturnPct ?? 0,
    invest: g.goal.monthlyInvest ?? null,
    pace: g.goal.monthlyPace ?? null,
  });

  const save = (next: Draft) => {
    const s = saved.current;
    if (next.target === s.target && next.pct === s.pct && next.invest === s.invest && next.pace === s.pace) return;
    setFailure(null);
    startTransition(async () => {
      try {
        const result = await saveNetWorthGoal({
          target: next.target,
          realReturnPct: next.pct,
          monthlyInvest: next.invest,
          monthlyPace: next.pace,
        });
        if (!result.ok) {
          setFailure(result.message);
          return;
        }
        saved.current = {
          target: result.goal.target,
          pct: result.goal.realReturnPct ?? 0,
          invest: result.goal.monthlyInvest ?? null,
          pace: result.goal.monthlyPace ?? null,
        };
        setSetOn(result.goal.returnSetOn);
      } catch {
        // Not "retry": a lapsed sign-in fails identically (boundaryCopy.ts).
        setFailure(ACTION_DID_NOT_COMPLETE);
      }
    });
  };
  const current: Draft = { target, pct, invest, pace: paceSet };
  const clearFailure = () => setFailure(null);

  const commitTarget = (typed: number | null) => {
    if (typed === null || typed <= 0) {
      setFailure("The target has to be a dollar amount above zero.");
      return false;
    }
    setTarget(typed);
    save({ ...current, target: typed });
    return true;
  };
  const commitReturn = () => save(current);

  // The figures as measured, and the saving as it stands untouched: the
  // measured pace, moved by an investing amount typed in place.
  const measuredDeposit = g.contribution ?? 0;
  const paceUntouched = g.basis === null ? 0 : withSaving(g.basis, { monthlyInvest: invest ?? undefined }).pace;

  const commitInvest = (typed: number | null) => {
    if (typed === null || typed < 0) {
      setFailure("The monthly amount has to be a dollar amount of zero or more.");
      return false;
    }
    // The measured amount, typed back, follows the data again.
    const next = g.contribution !== null && sameAmount(typed, g.contribution) ? null : typed;
    setInvest(next);
    save({ ...current, invest: next });
    return true;
  };
  const commitPace = (typed: number | null) => {
    if (typed === null) {
      setFailure("The monthly saving has to be a dollar amount.");
      return false;
    }
    const next = sameAmount(typed, paceUntouched) ? null : typed;
    setPaceSet(next);
    save({ ...current, pace: next });
    return true;
  };
  const useMeasuredDeposit = () => {
    setInvest(null);
    save({ ...current, invest: null });
  };
  const useMeasuredPace = () => {
    setPaceSet(null);
    save({ ...current, pace: null });
  };

  const reached = g.netWorth >= target;
  const progress = Math.min(1, Math.max(0, g.netWorth / target));
  // The bases with the figures set, if any: both dates move with them.
  const set: SavingOverrides = { monthlyInvest: invest ?? undefined, monthlyPace: paceSet ?? undefined };
  const basis = g.basis === null ? null : withSaving(g.basis, set);
  const previousBasis = g.previousBasis === null ? null : withSaving(g.previousBasis, set);
  const projection =
    basis === null || reached ? null : projectGoal(basis, previousBasis, target, pct > 0 ? pct : undefined);
  const shownPace = paceSet ?? paceUntouched;
  const shownDeposit = invest ?? measuredDeposit;
  // What today's dollars ask, at the assumed inflation: the date the note
  // prices the target at is the nearer one on screen.
  const grow = (years: number) => Math.pow(1 + ASSUMED_INFLATION_PCT / 100, years);
  const noteDate = projection?.markets?.lands ?? projection?.saving.lands ?? null;
  const yearsTo = (key: string) => (basis === null ? 0 : monthsBetween(basis.anchor, key) / 12);
  const cashShares = g.cash === null ? [] : wholePercents(g.cash.accounts.map((a) => a.share));
  // Idle cash, priced in months: the nearer date on screen, with the idle
  // amount earning what the best-paying account pays from now on.
  const idle = g.idle;
  const idleSooner = (() => {
    if (idle === null || basis === null || projection === null) return 0;
    const moved = projectGoal(withCashMoved(basis, idle.idle, idle.to.nominalPct), null, target, pct > 0 ? pct : undefined);
    const now = projection.markets?.lands ?? projection.saving.lands;
    const then = projection.markets !== null ? moved.markets?.lands : moved.saving.lands;
    return now === null || then === null || then === undefined ? 0 : monthsBetween(then, now);
  })();
  const keeping =
    invest === null && g.contribution !== null && g.contribution > 0 && (g.contributionYearAgo ?? 0) > 0
      ? keepingUp(g.contribution, g.contributionYearAgo!)
      : null;

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
      ) : projection === null || basis === null ? (
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
              <Landing p={projection.saving} pace={basis.pace} />
              <Shift p={projection.saving} />
            </div>
            {projection.markets !== null && (
              <div className="grid gap-0.5">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="inline-block h-[9px] w-[9px] rounded-[2px] bg-chart2" />
                  <span className={FIELD_LABEL}>With markets at {pct}%</span>
                  <span className={PROJECTED_CHIP}>Projected</span>
                </span>
                <Landing p={projection.markets} pace={basis.pace} />
                <Shift p={projection.markets} />
              </div>
            )}
          </div>

          <div className="mt-3">
            <GoalPathChart
              recent={g.recent}
              recentLabel="Net worth"
              anchor={basis.anchor}
              target={target}
              projections={pathsFor(basis, target, pct, projection.saving.lands, projection.markets?.lands ?? null)}
            />
          </div>
        </>
      )}

      {/* The numbers the operator sets. Each saves when it settles: a typed
          amount on Enter or leaving the field, the return on release. */}
      <div className="mt-3 grid grid-cols-1 items-center gap-x-3 gap-y-1 text-[0.78rem] text-faint md:grid-cols-[auto_1fr] md:gap-y-2">
        <label htmlFor="nw-goal-target" className={LABEL}>
          Target
        </label>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AmountInput key={`target:${target}`} id="nw-goal-target" value={target} onEdit={clearFailure} onCommit={commitTarget} />
          <span>in today&apos;s dollars</span>
        </span>

        <label htmlFor="nw-goal-return" className={LABEL}>
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
            <option value={returnToSlider(10)} />
          </datalist>
          <span className="font-money tabular text-ink">{pct}%</span>
          {pct > 0 && <span className={ASSUMED_CHIP}>Assumed</span>}
        </span>

        <p className="text-[0.72rem] leading-relaxed md:col-span-2">
          {pct === 0
            ? "No market growth assumed, so there is one date. "
            : `A year after inflation, your figure, applied to invested money only${setOn !== undefined ? `, set ${shortDateYear(new Date(`${setOn}T12:00:00Z`))}` : ""}. `}
          Forecasts for the next decade sit near 4%; US stocks returned about 7% over the last century.
        </p>

        {g.basis !== null && (
          <>
            <label htmlFor="nw-goal-pace" className={LABEL}>
              Saving per month
            </label>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <AmountInput
                key={`pace:${shownPace}`}
                id="nw-goal-pace"
                value={shownPace}
                negative
                onEdit={clearFailure}
                onCommit={commitPace}
              />
              {paceSet === null ? (
                <span>your last {NET_WORTH_PACE_MONTHS} months, one-off pay left out</span>
              ) : (
                <>
                  <span className={ASSUMED_CHIP}>Assumed</span>
                  <button
                    type="button"
                    onClick={useMeasuredPace}
                    className={`${CONTROL} tap44 border-rule text-faint hover:border-acc hover:text-acc`}
                  >
                    Use your usual, <span className="font-money tabular">{money(paceUntouched)}</span>
                  </button>
                </>
              )}
            </span>
          </>
        )}

        <label htmlFor="nw-goal-invest" className={LABEL}>
          Invested per month
        </label>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AmountInput
            key={`invest:${shownDeposit}`}
            id="nw-goal-invest"
            value={shownDeposit}
            onEdit={clearFailure}
            onCommit={commitInvest}
          />
          {invest === null ? (
            <span>{g.contribution === null ? "no regular deposit measured yet" : "your usual, the last three months"}</span>
          ) : (
            <>
              <span className={ASSUMED_CHIP}>Assumed</span>
              <button
                type="button"
                onClick={useMeasuredDeposit}
                className={`${CONTROL} tap44 border-rule text-faint hover:border-acc hover:text-acc`}
              >
                Use your usual, <span className="font-money tabular">{money(measuredDeposit)}</span>
              </button>
            </>
          )}
        </span>

        <p className="text-[0.72rem] leading-relaxed md:col-span-2">
          {paceSet !== null
            ? "The saving you set is the whole of it; the investing is the part of it that earns the return."
            : invest !== null
              ? "The investing you set is part of your saving: what is left of it is counted as cash, and the total stays as it is."
              : "What you save in all, and the part of it that goes into invested accounts. Type other amounts to see what saving or investing more would do."}
          {pending && " Saving…"}
          {failure !== null && <span className="text-neg"> {failure}</span>}
        </p>
      </div>

      {/* Today's dollars assume the saving rises with inflation: say what that
          asks, and whether the investing has kept up over the past year. */}
      {basis !== null && !reached && basis.pace > 0 && (
        <p className="pt-2 text-[0.78rem] leading-relaxed text-faint">
          In today&apos;s dollars, with inflation at {ASSUMED_INFLATION_PCT}% a year{" "}
          <span className={ASSUMED_CHIP}>Assumed</span>: the dates hold if what you save rises with it, so{" "}
          <span className="font-money tabular">~{money(basis.pace)}</span>/mo now is about{" "}
          <span className="font-money tabular">{roughly.format(basis.pace * grow(10))}</span>/mo in ten years
          {noteDate !== null && (
            <>
              , and the <span className="font-money tabular">{money(target)}</span> target is about{" "}
              <span className="font-money tabular">{roughly.format(target * grow(yearsTo(noteDate)))}</span> in
              the dollars of {monthLabel(noteDate)}
            </>
          )}
          .
        </p>
      )}
      {/* Cash earns what it was measurably paid, less the assumed inflation:
          each account named, so a checking balance losing ground is seen. */}
      {basis !== null && !reached && g.cash !== null && (
        <p className="pt-1.5 text-[0.78rem] leading-relaxed text-faint">
          Cash {g.cash.realPct < 0 ? "loses" : "earns"} about{" "}
          <span className="font-money tabular">{percent(Math.abs(g.cash.realPct))}</span> a year after inflation, from what
          each account was paid over the last three months:{" "}
          {g.cash.accounts.map((a, k) => (
            <span key={a.id}>
              {k > 0 && "; "}
              {a.name} {a.nominalPct === 0 ? "pays nothing" : <>pays about <span className="font-money tabular">{percent(a.nominalPct)}</span></>}
              {" "}({cashShares[k]}% of your cash)
            </span>
          ))}
          .
        </p>
      )}
      {/* Money waiting where it earns nothing, beyond a month of spending:
          the account that pays most is where it would keep its value. */}
      {idle !== null && !reached && (
        <p className="pt-1.5 text-[0.78rem] leading-relaxed text-[color:var(--warn-ink)]">
          {idle.from.join(" + ")} {idle.from.length === 1 ? "holds" : "hold"}{" "}
          <span className="font-money tabular">{money(idle.held)}</span>, about {(idle.held / idle.buffer).toFixed(1)}{" "}
          months of your spending (<span className="font-money tabular">~{roughly.format(idle.buffer)}</span>/mo). Beyond
          a month, <span className="font-money tabular">{roughly.format(idle.idle)}</span> earns nothing; in {idle.to.name}{" "}
          at about {percent(idle.to.nominalPct)} it would earn about{" "}
          <span className="font-money tabular">{roughly.format(idle.yearly)}</span> a year
          {idleSooner > 0 && (
            <>
              {" "}
              and bring {projection?.markets != null ? "the date with markets" : "the date"} about {idleSooner}{" "}
              {monthsWord(idleSooner)} sooner
            </>
          )}
          .
        </p>
      )}
      {keeping !== null && g.contributionYearAgo !== null && (
        <p className={`pt-1.5 text-[0.78rem] leading-relaxed ${keeping.behind ? "text-[color:var(--warn-ink)]" : "text-faint"}`}>
          Your monthly investing,{" "}
          <span className="font-money tabular">{money(g.contribution ?? 0)}</span>, is{" "}
          {keeping.changePct === 0
            ? "the same as"
            : `${keeping.changePct > 0 ? "up" : "down"} ${Math.abs(keeping.changePct)}% on`}{" "}
          a year ago (<span className="font-money tabular">{money(g.contributionYearAgo)}</span>)
          {keeping.behind ? (
            <>
              . Keeping up with {ASSUMED_INFLATION_PCT}% inflation means about{" "}
              <span className="font-money tabular">{money(keeping.needed)}</span> now, and raising it each year.
            </>
          ) : (
            <>, ahead of {ASSUMED_INFLATION_PCT}% inflation.</>
          )}
        </p>
      )}

      {/* A paycheck at a new amount: counted as itself until it repeats, or
          until the operator says it is the new pay. Only a PAYCHECK asks; a
          bonus beside one never does. */}
      {g.basis !== null &&
        g.payPending.map((p) => (
          <p key={`pending:${p.payer}:${p.date}`} className="pt-1.5 text-[0.78rem] leading-relaxed text-[color:var(--warn-ink)]">
            Your paycheck from {titleCase(p.payer)} on {shortDateYear(new Date(`${p.date}T12:00:00Z`))} came to{" "}
            <span className="font-money tabular">{money(p.amount)}</span>, {p.amount > p.from ? "up" : "down"} from{" "}
            <span className="font-money tabular">{money(p.from)}</span>. It counts as it is; if it is your new pay, the
            dates can project from it now, and otherwise once it repeats.{" "}
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setFailure(null);
                startTransition(async () => {
                  try {
                    const result = await confirmNewPay({ payer: p.payer, date: p.date });
                    if (!result.ok) setFailure(result.message);
                  } catch {
                    setFailure(ACTION_DID_NOT_COMPLETE);
                  }
                });
              }}
              className={`${CONTROL} tap44 border-rule text-ink hover:border-acc hover:text-acc`}
            >
              This is my new pay
            </button>
          </p>
        ))}

      {/* What the reader must be able to discount stays in view. */}
      {g.unmatchedDeposit !== null && pct > 0 && invest === null && (
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
              {g.paceLeavesOut.length > 0 && (
                <>
                  {" "}
                  It leaves out one-off pay:{" "}
                  {g.paceLeavesOut.map((o, k) => (
                    <span key={`${o.date}:${o.amount}`}>
                      {k > 0 && ", "}
                      <span className="font-money tabular">{money(o.amount)}</span> on{" "}
                      {shortDateYear(new Date(`${o.date}T12:00:00Z`))}
                    </span>
                  ))}
                  .
                </>
              )}
              {g.payChanges.map((c) => (
                <span key={`change:${c.payer}:${c.since}`}>
                  {" "}
                  It projects your pay as it is now: <span className="font-money tabular">{money(c.to)}</span> a
                  paycheck from {titleCase(c.payer)} since {shortDateYear(new Date(`${c.since}T12:00:00Z`))}
                  {c.told ? ", as you said" : ""}, {c.to > c.from ? "up" : "down"} from{" "}
                  <span className="font-money tabular">{money(c.from)}</span>, so the earlier paychecks count at it.
                </span>
              ))}
            </p>
            {(invest !== null || paceSet !== null) && basis !== null && (
              <p>
                Saving <span className="font-money tabular text-ink">~{money(basis.pace)}</span>/mo
                {paceSet !== null ? ", the amount you set," : " in all,"} investing{" "}
                <span className="font-money tabular text-ink">{money(basis.contribution ?? 0)}</span>/mo of it
                {invest !== null ? ", the amount you set" : ", your usual"}.
                {pct > 0 && g.invested !== null && (
                  <>
                    {" "}
                    That and the <span className="font-money tabular">{money(g.invested)}</span> invested earn the
                    return; the rest is counted as cash.
                  </>
                )}
              </p>
            )}
            {invest === null && paceSet === null && pct > 0 && g.invested !== null && (
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
