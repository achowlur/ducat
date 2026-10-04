"use client";

import Link from "next/link";
import { amount, money } from "../../lib/ui/format";
import type { Comparison } from "../../lib/ui/report";
import { COLUMN_HEADER } from "../ui/headings";

const TH = `py-1 ${COLUMN_HEADER}`;

/** "$1,204": a figure that only gives a change its scale, where cents are noise. */
function wholeMoney(n: number): string {
  const v = Math.round(Math.abs(n)).toLocaleString("en-US");
  return n < 0 ? `−$${v}` : `$${v}`;
}

/** "+$1,204.10", "−$88.00": a headline change. */
export function signedMoney(n: number): string {
  return n > 0 ? `+${money(n)}` : money(n);
}

/** "+1,204.10", "−88.00": a change in a column, which carries no "$" in Ducat. */
function signedAmount(n: number): string {
  return n > 0 ? `+${amount(n)}` : amount(n);
}

/**
 * Two spans, group by group: how much each moved (diverging bars), both
 * figures side by side, or a table. The rows add up to the change the card's
 * headline states: merchants past the named few are summed into one row
 * rather than dropped. Only the table closes with a total row; under the bars
 * it would repeat the headline.
 *
 * Colour carries direction for the READER, not the sign: more spending is the
 * warning colour, more income the good one.
 */
export function ChangeView({
  view,
  comparison,
  measure,
  currentName,
  priorName,
  noun,
}: {
  view: "change" | "side" | "table";
  comparison: Comparison;
  measure: "spending" | "income";
  /** Short names for the two spans, used as column heads: "Last 12", "The 12 before". */
  currentName: string;
  priorName: string;
  noun: string;
}) {
  const { rows, rest, total } = comparison;
  if (rows.length === 0) {
    return <p className="py-4 text-[0.85rem] text-faint">Nothing recorded in either span.</p>;
  }
  const tone = (n: number) =>
    n === 0 ? "text-faint" : (n > 0) === (measure === "spending") ? "text-neg" : "text-pos";
  const fill = (n: number) => ((n > 0) === (measure === "spending") ? "bg-neg" : "bg-pos");
  const all = rest === null ? rows : [...rows, { ...rest, key: "rest", label: `${rest.count} more ${noun}`, href: null }];

  if (view === "table") {
    return (
      <table className="w-full max-w-[720px] border-collapse">
        <thead>
          <tr className="border-b border-ink">
            <th scope="col" className={`${TH} text-left`}>
              Name
            </th>
            <th scope="col" className={`${TH} pl-3 text-right`}>
              {priorName}
            </th>
            <th scope="col" className={`${TH} pl-3 text-right`}>
              {currentName}
            </th>
            <th scope="col" className={`${TH} pl-3 text-right`}>
              Change
            </th>
          </tr>
        </thead>
        <tbody>
          {all.map((r) => (
            <tr key={r.key} className="border-b border-rule">
              <td className="max-w-0 truncate py-1.5 text-[0.85rem] md:max-w-none">
                {r.href === null ? (
                  <span className="text-faint">{r.label}</span>
                ) : (
                  <Link href={r.href} className="hover:underline">
                    {r.label}
                  </Link>
                )}
              </td>
              <td className="py-1.5 pl-3 text-right font-money text-[0.85rem] tabular text-faint">{amount(r.prior)}</td>
              <td className="py-1.5 pl-3 text-right font-money text-[0.85rem] tabular">{amount(r.current)}</td>
              <td className={`py-1.5 pl-3 text-right font-money text-[0.85rem] tabular ${tone(r.change)}`}>
                {r.change === 0 ? "0.00" : `${r.change > 0 ? "+" : ""}${amount(r.change)}`}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-ink font-semibold">
            <th scope="row" className="py-1.5 text-left text-[0.85rem]">
              Total
            </th>
            <td className="py-1.5 pl-3 text-right font-money text-[0.85rem] tabular">{amount(total.prior)}</td>
            <td className="py-1.5 pl-3 text-right font-money text-[0.85rem] tabular">{amount(total.current)}</td>
            <td className={`py-1.5 pl-3 text-right font-money text-[0.85rem] tabular ${tone(total.change)}`}>
              {total.change > 0 ? "+" : ""}
              {amount(total.change)}
            </td>
          </tr>
        </tbody>
      </table>
    );
  }

  const grid =
    "grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_6.6rem] items-center gap-3 py-1.5 text-[0.85rem] max-md:min-h-[44px] md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_7.5rem]";
  const biggest = Math.max(...all.map((r) => (view === "change" ? Math.abs(r.change) : Math.max(r.current, r.prior))), 0.01);

  const body = (r: (typeof all)[number]) =>
    view === "change" ? (
      <>
        {/* The change alone cannot say whether Groceries doubled or barely
            moved, so the two amounts it is the difference of sit under the
            name, rounded: the table holds them to the cent. */}
        <span className="grid min-w-0 leading-tight">
          <span className="truncate">{r.label}</span>
          <span className="truncate font-money text-[0.7rem] text-faint tabular">
            {wholeMoney(r.prior)} → {wholeMoney(r.current)}
          </span>
        </span>
        <span className="relative block h-[14px]">
          <span className="absolute -bottom-1.5 -top-1.5 left-1/2 border-l border-ink" />
          {r.change !== 0 && (
            <span
              className={`absolute top-[2px] h-[10px] rounded-[1px] opacity-75 ${fill(r.change)}`}
              style={{
                [r.change > 0 ? "left" : "right"]: "50%",
                width: `${Math.max((Math.abs(r.change) / biggest) * 50, 0.6).toFixed(1)}%`,
              }}
            />
          )}
        </span>
        <span className={`text-right font-money text-[0.85rem] tabular ${tone(r.change)}`}>{signedAmount(r.change)}</span>
      </>
    ) : (
      <>
        <span className="truncate">{r.label}</span>
        <span className="grid gap-[3px]">
          <span className="block h-[7px] rounded-[1px] bg-faint opacity-45" style={{ width: `${Math.max((Math.max(r.prior, 0) / biggest) * 100, 0).toFixed(1)}%` }} />
          <span className="block h-[7px] rounded-[1px] bg-chart1" style={{ width: `${Math.max((Math.max(r.current, 0) / biggest) * 100, 0).toFixed(1)}%` }} />
        </span>
        <span className="text-right font-money text-[0.85rem] leading-tight tabular">
          {amount(r.current)}
          <br />
          <span className="text-[0.7rem] text-faint">{amount(r.prior)}</span>
        </span>
      </>
    );

  // In the change view a row that did not move says nothing about what
  // changed: those are named once, together, below the rows that did.
  const shown = view === "change" ? all.filter((r) => r.change !== 0) : all;
  const still = view === "change" ? all.filter((r) => r.change === 0) : [];

  return (
    <div className="max-w-[760px]">
      {view === "side" && (
        <div className="mb-1 flex flex-wrap gap-x-4 text-[0.72rem] text-faint">
          <span>
            <i className="mr-1.5 inline-block h-[9px] w-[9px] rounded-[2px] bg-chart1 align-[-1px]" />
            {currentName}
          </span>
          <span>
            <i className="mr-1.5 inline-block h-[9px] w-[9px] rounded-[2px] bg-faint align-[-1px] opacity-45" />
            {priorName}
          </span>
        </div>
      )}
      <ul>
        {shown.map((r) => (
          <li key={r.key} className="border-t border-rule first:border-t-0">
            {r.href === null ? (
              <div className={`${grid} text-faint`}>{body(r)}</div>
            ) : (
              <Link href={r.href} className={`${grid} hover:bg-chip/60`}>
                {body(r)}
              </Link>
            )}
          </li>
        ))}
      </ul>
      {still.length > 0 && (
        <p className="mt-1 border-t border-rule pt-1.5 text-[0.75rem] text-faint">
          No change:{" "}
          {still.map((r, i) => (
            <span key={r.key}>
              {i > 0 && ", "}
              <span className="text-ink">{r.label}</span> <span className="font-money tabular">{wholeMoney(r.current)}</span>
            </span>
          ))}
          .
        </p>
      )}
    </div>
  );
}
