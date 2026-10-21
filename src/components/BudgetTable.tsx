"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { saveBudgetEdit } from "../app/budget/actions";
import { dollars, type BudgetLine } from "../lib/ui/budget";
import { ACTION_DID_NOT_COMPLETE } from "../lib/ui/boundaryCopy";
import { PaceField } from "./goals/PaceField";
import { CHIP, COLUMN_HEADER, CONTROL } from "./ui/headings";

/**
 * The budget as Overview draws its accounts: a ruled table, the ring's swatch
 * as each row's legend, spent of limit over the END of an equal-length bar
 * (the bar is the limit), and ONE figure on the right, what is left, below
 * zero in the warning ink. A TOTAL row at the foot. Tapping a name opens that
 * row's limit; a save refreshes the page, which recomputes every figure on
 * the server.
 */
export function BudgetTable({ lines, swatches }: { lines: BudgetLine[]; swatches?: Record<string, string> }) {
  const spent = lines.reduce((s, l) => s + l.spent, 0);
  const limit = lines.reduce((s, l) => s + l.limit, 0);
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-ink">
          <th scope="col" className={`py-1 text-left ${COLUMN_HEADER}`}>
            Category
          </th>
          <th scope="col" className={`w-px whitespace-nowrap py-1 pl-4 text-right ${COLUMN_HEADER}`}>
            Left
          </th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <BudgetRow key={`${line.key}-${line.yearly}-${line.limit}`} line={line} swatch={swatches?.[line.key] ?? null} />
        ))}
      </tbody>
      {lines.length > 1 && (
        <tfoot>
          <tr className="border-t border-ink">
            <th scope="row" className="py-2 text-left text-[0.88rem] font-semibold">
              Total{" "}
              <span className="font-money text-[0.7rem] font-normal tabular text-faint">
                <span className="text-ink">{whole(spent)}</span> of {whole(limit)}
              </span>
            </th>
            <td className="w-px whitespace-nowrap py-2 pl-4 text-right">
              <Remaining left={limit - spent} strong />
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}

/** Whole dollars without the sign, over the bar where $ would repeat. */
const whole = (n: number) => dollars(n).replace("$", "");
const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** What is left, the row's one figure: below zero is over, in the warning ink with a minus. */
function Remaining({ left, strong = false }: { left: number; strong?: boolean }) {
  return (
    <span
      className={`font-money text-[0.95rem] tabular ${strong ? "font-semibold" : ""} ${
        left < 0 ? "text-warn-ink" : "text-ink"
      }`}
    >
      {dollars(left)}
    </span>
  );
}

/** Swatch, name and status chip with spent of limit over the bar's end, then the bar. */
function NameBlock({ line, swatch }: { line: BudgetLine; swatch: string | null }) {
  const fill = line.limit > 0 ? Math.min(1, Math.max(0, line.spent / line.limit)) : line.spent > 0 ? 1 : 0;
  const mark = line.limit > 0 ? Math.min(1, line.expectedByToday / line.limit) : null;
  return (
    <>
      {swatch !== null && <i className={`mt-[4px] h-[11px] w-[11px] shrink-0 rounded-[2px] ${swatch}`} />}
      <span className="min-w-0 flex-1">
        {/* Both lines stop short of the figure column by the same inset, so
            spent of limit ends exactly where the bar (the limit) does. */}
        <span className="flex items-baseline justify-between gap-3 pr-6 leading-tight sm:pr-[3.5rem]">
          <span className="flex min-w-0 items-center gap-1.5">
            {line.name}
            {line.status === "over" && <span className={`${CHIP} bg-warn text-on-warn`}>Over</span>}
            {line.status === "ahead" && <span className={`${CHIP} bg-warn text-on-warn`}>Ahead</span>}
          </span>
          <span className="shrink-0 font-money text-[0.7rem] tabular text-faint">
            <span className="text-ink">{whole(line.spent)}</span> of {whole(line.limit)}
          </span>
        </span>
        {/* Filled in the ring's colour for the category, the tick where it
            usually is by today. Every bar the same length, so rows compare
            at a glance. */}
        <span className="mt-1.5 flex items-center pr-6 sm:pr-[3.5rem]">
          <span className="relative block h-1 min-w-0 flex-1 rounded-[1px] bg-rule" aria-hidden="true">
            <span
              className={`block h-full rounded-[1px] ${swatch !== null && swatch !== "bg-rule" ? swatch : "bg-acc"}`}
              style={{ width: `${fill * 100}%` }}
            />
            {mark !== null && (
              <span className="absolute -top-0.5 block h-2 w-0.5 bg-ink" style={{ left: `calc(${mark * 100}% - 1px)` }} />
            )}
          </span>
        </span>
      </span>
    </>
  );
}

function BudgetRow({ line, swatch }: { line: BudgetLine; swatch: string | null }) {
  const figure = (
    <td className="w-px whitespace-nowrap py-2 pl-4 text-right align-top">
      <Remaining left={line.limit - line.spent} />
    </td>
  );
  // The folded line adds up categories that each have their own limit: it
  // has none of its own to edit.
  if (line.folded !== undefined) {
    return (
      <tr className="border-b border-rule">
        <td className="py-2 text-[0.88rem]">
          <span className="flex w-full items-start gap-2">
            <NameBlock line={line} swatch={swatch} />
          </span>
        </td>
        {figure}
      </tr>
    );
  }
  return (
    <Editable line={line}>
      {(toggle, open) => (
        <tr className={open ? "" : "border-b border-rule"}>
          <td className="py-2 text-[0.88rem]">
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className="flex w-full items-start gap-2 text-left max-md:min-h-[44px]"
            >
              <NameBlock line={line} swatch={swatch} />
            </button>
          </td>
          {figure}
        </tr>
      )}
    </Editable>
  );
}

/** A row, then its editor as a row of its own: the limit, the suggestion back, monthly or yearly. */
function Editable({ line, children }: { line: BudgetLine; children: (toggle: () => void, open: boolean) => ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = (edit: Parameters<typeof saveBudgetEdit>[0]) => {
    setFailure(null);
    startTransition(async () => {
      try {
        const result = await saveBudgetEdit(edit);
        if (!result.ok) {
          setFailure(result.message);
          return;
        }
        router.refresh();
      } catch {
        setFailure(ACTION_DID_NOT_COMPLETE);
      }
    });
  };

  return (
    <>
      {children(() => setOpen((o) => !o), open)}
      {(open || failure !== null) && (
        <tr className="border-b border-rule">
          <td colSpan={2}>
            {open && (
              <div className="flex flex-wrap items-center gap-2 py-3 text-[0.8rem]">
                <PaceField
                  id={`budget-${line.key}`}
                  value={line.limit}
                  onDraft={() => {}}
                  onCommit={(typed) => {
                    if (typed === null || typed < 0) {
                      setFailure("A limit is a dollar amount of zero or more.");
                      return false;
                    }
                    // The suggestion, typed back, follows the data again.
                    const next = sameAmount(typed, line.suggested) ? null : typed;
                    if (next === null && !line.typed) return true;
                    save({ kind: "limit", key: line.key, limit: next });
                    return true;
                  }}
                />
                <span className="text-faint">{line.yearly ? "a year" : "a month"}</span>
                {line.typed && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => save({ kind: "limit", key: line.key, limit: null })}
                    className={`${CONTROL} tap44 border-rule text-acc hover:border-acc`}
                  >
                    Suggested {dollars(line.suggested)}
                  </button>
                )}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    save({ kind: "yearly", key: line.key, yearly: !line.yearly, yearlyByDefault: line.yearlyByDefault })
                  }
                  className={`${CONTROL} tap44 border-rule text-acc hover:border-acc`}
                >
                  {line.yearly ? "Make monthly" : "Make yearly"}
                </button>
              </div>
            )}
            {failure !== null && <p className="pb-3 text-[0.78rem] text-warn-ink">{failure}</p>}
          </td>
        </tr>
      )}
    </>
  );
}
