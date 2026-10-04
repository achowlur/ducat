"use client";

import Link from "next/link";
import { amount, money } from "../../lib/ui/format";
import { sliceFill, sliceSwatch } from "../../lib/ui/donutColors";
import { wholePercents } from "../../lib/ui/spendingBreakdown";
import type { GroupTotal } from "../../lib/ui/report";
import { COLUMN_HEADER } from "../ui/headings";

/** Rows the bar view names before summing the rest; the table names every one. */
const BAR_ROWS = 12;
/** Named slices before Other: Overview's ring allows seven hues and a neutral. */
const PIE_SLICES = 7;

const TH = `py-1 ${COLUMN_HEADER}`;

/**
 * Parts of one whole: groups over a span, as bars, a pie or a table. Every
 * row opens the ledger behind it. A group that ended the span in credit
 * (refunds outran it) draws no bar and holds no slice, because a share of a
 * whole cannot be negative; its figure is still printed, and the printed
 * total is always the NET one.
 */
export function PartsView({
  view,
  groups,
  total,
  noun,
}: {
  view: "bars" | "pie" | "table";
  groups: GroupTotal[];
  total: number;
  /** Plural, for the folded row: "merchants". */
  noun: string;
}) {
  if (groups.length === 0) {
    return <p className="py-4 text-[0.85rem] text-faint">Nothing recorded over these months.</p>;
  }
  const positive = groups.filter((g) => g.total > 0);
  const drawable = positive.reduce((s, g) => s + Math.round(g.total * 100), 0) / 100;
  const credited = Math.round((drawable - total) * 100) / 100;
  const note =
    credited > 0 ? (
      <p className="mt-2 text-[0.72rem] text-faint">
        Shares are of the {money(drawable)} in groups with net spending; the total also nets {money(credited)}{" "}
        refunded elsewhere.
      </p>
    ) : null;

  if (view === "pie") return <Pie positive={positive} groups={groups} total={total} drawable={drawable} note={note} />;
  if (view === "table") return <Table groups={groups} total={total} drawable={drawable} note={note} />;

  // A fold holding ONE group would hide a name for nothing.
  const named = groups.length <= BAR_ROWS + 1 ? groups.length : BAR_ROWS;
  const shown = groups.slice(0, named);
  const folded = groups.slice(named);
  const foldedTotal = folded.reduce((s, g) => s + Math.round(g.total * 100), 0) / 100;
  const scale = Math.max(...shown.map((g) => g.total), foldedTotal, 0.01);
  return (
    <div>
      <ul className="max-w-[720px]">
        {shown.map((g) => (
          <li key={g.key} className="border-t border-rule first:border-t-0">
            <Link
              href={g.href}
              className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_6.6rem] items-center gap-3 py-1.5 text-[0.85rem] hover:bg-chip/60 max-md:min-h-[44px] md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_7.5rem]"
            >
              <span className="truncate">{g.label}</span>
              <Bar value={g.total} scale={scale} />
              <span className={`text-right font-money text-[0.85rem] tabular ${g.total < 0 ? "text-pos" : ""}`}>{amount(g.total)}</span>
            </Link>
          </li>
        ))}
        {folded.length > 0 && (
          <li className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_6.6rem] items-center gap-3 border-t border-rule py-1.5 text-[0.85rem] text-faint max-md:min-h-[44px] md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_7.5rem]">
            <span className="truncate">
              {folded.length} more {noun}
            </span>
            <Bar value={foldedTotal} scale={scale} muted />
            <span className="text-right font-money text-[0.85rem] tabular">{amount(foldedTotal)}</span>
          </li>
        )}
        <li className="flex justify-between border-t border-ink py-1.5 text-[0.85rem]">
          <span className="font-semibold">Total</span>
          <span className="font-money tabular">{amount(total)}</span>
        </li>
      </ul>
      {folded.length > 0 && (
        <p className="mt-1 text-[0.72rem] text-faint">Table names all {groups.length}.</p>
      )}
      {note}
    </div>
  );
}

function Bar({ value, scale, muted = false }: { value: number; scale: number; muted?: boolean }) {
  return (
    <span className="block h-[11px]">
      {value > 0 && (
        <span
          className={`block h-full rounded-[1px] ${muted ? "bg-pie-other" : "bg-chart1"}`}
          style={{ width: `${Math.max((value / scale) * 100, 0.8).toFixed(1)}%` }}
        />
      )}
    </span>
  );
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function arc(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  const large = a1 - a0 > 180 ? 1 : 0;
  const o0 = polar(cx, cy, R, a0);
  const o1 = polar(cx, cy, R, a1);
  const i0 = polar(cx, cy, r, a0);
  const i1 = polar(cx, cy, r, a1);
  const f = (p: { x: number; y: number }) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  return `M${f(o0)} A${R},${R} 0 ${large} 1 ${f(o1)} L${f(i1)} A${r},${r} 0 ${large} 0 ${f(i0)} Z`;
}

function Pie({
  positive,
  groups,
  total,
  drawable,
  note,
}: {
  positive: GroupTotal[];
  groups: GroupTotal[];
  total: number;
  drawable: number;
  note: React.ReactNode;
}) {
  if (positive.length === 0) {
    return (
      <p className="py-4 text-[0.85rem] text-faint">
        Refunds outran every group over these months, so there is no whole to divide. The table shows each figure.
      </p>
    );
  }
  // An Other holding ONE group would hide a name for nothing.
  const named = positive.length <= PIE_SLICES + 1 ? positive.length : PIE_SLICES;
  const rest = positive.slice(named);
  const slices = [
    ...positive.slice(0, named).map((g) => ({ label: g.label, value: g.total, href: g.href as string | null, isOther: false })),
    ...(rest.length > 0
      ? [{ label: `Other · ${rest.length}`, value: rest.reduce((s, g) => s + g.total, 0), href: null, isOther: true }]
      : []),
  ];
  const pct = wholePercents(slices.map((s) => s.value / drawable));
  let angle = 0;
  const arcs = slices.map((s, i) => {
    const a0 = angle;
    const sweep = (s.value / drawable) * 360;
    angle += sweep;
    return { d: arc(100, 100, 92, 56, a0, Math.min(a0 + sweep, a0 + 359.9)), fill: sliceFill(s, i) };
  });
  const credit = groups.filter((g) => g.total < 0);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-6">
        <svg viewBox="0 0 200 200" width="190" height="190" role="img" aria-label="Pie of the groups' shares" className="mx-auto md:mx-0">
          <g stroke="var(--paper)" strokeWidth="1.5">
            {arcs.map((a, i) => (
              <path key={i} d={a.d} fill={a.fill} />
            ))}
          </g>
          <text x="100" y="98" textAnchor="middle" className="fill-[var(--ink)] font-money text-[13px]">
            {money(total)}
          </text>
          <text x="100" y="114" textAnchor="middle" className="fill-[var(--faint)] font-money text-[10px]">
            total
          </text>
        </svg>
        <ul className="min-w-[240px] max-w-[420px] flex-1">
          {slices.map((s, i) => {
            const row = (
              <>
                <i className={`inline-block h-[10px] w-[10px] rounded-[2px] ${sliceSwatch(s, i)}`} />
                <span className="truncate">{s.label}</span>
                <span className="font-money tabular">{amount(s.value)}</span>
                <span className="text-right font-money tabular text-faint">{pct[i]}%</span>
              </>
            );
            const cls =
              "grid grid-cols-[12px_minmax(0,1fr)_auto_2.6rem] items-center gap-2 py-1 font-money text-[0.78rem] max-md:min-h-[44px]";
            return (
              <li key={s.label} className="border-t border-rule first:border-t-0">
                {s.href === null ? (
                  <div className={`${cls} text-faint`}>{row}</div>
                ) : (
                  <Link href={s.href} className={`${cls} hover:bg-chip/60`}>
                    {row}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {credit.length > 0 && (
        <p className="mt-2 text-[0.72rem] text-faint">
          No slice for what ended in credit:{" "}
          {credit.map((g, i) => (
            <span key={g.key}>
              {i > 0 && ", "}
              <Link href={g.href} className="text-ink hover:underline">
                {g.label}
              </Link>{" "}
              <span className="font-money">{money(g.total)}</span>
            </span>
          ))}
          .
        </p>
      )}
      {note}
    </div>
  );
}

function Table({
  groups,
  total,
  drawable,
  note,
}: {
  groups: GroupTotal[];
  total: number;
  drawable: number;
  note: React.ReactNode;
}) {
  const pct = wholePercents(groups.map((g) => (drawable > 0 && g.total > 0 ? g.total / drawable : null)));
  return (
    <div>
      <table className="w-full max-w-[640px] border-collapse">
        <thead>
          <tr className="border-b border-ink">
            <th scope="col" className={`${TH} text-left`}>
              Name
            </th>
            <th scope="col" className={`${TH} pl-3 text-right`}>
              Amount
            </th>
            <th scope="col" className={`${TH} pl-3 text-right`}>
              Share
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g, i) => (
            <tr key={g.key} className="border-b border-rule">
              <td className="max-w-0 truncate py-1.5 text-[0.85rem] md:max-w-none">
                <Link href={g.href} className="hover:underline">
                  {g.label}
                </Link>
              </td>
              <td className="py-1.5 pl-3 text-right font-money text-[0.85rem] tabular">{amount(g.total)}</td>
              <td className="py-1.5 pl-3 text-right font-money text-[0.78rem] tabular text-faint">
                {g.total > 0 && drawable > 0 ? `${pct[i]}%` : "—"}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-ink">
            <th scope="row" className="py-1.5 text-left text-[0.85rem] font-semibold">
              Total
            </th>
            <td className="py-1.5 pl-3 text-right font-money text-[0.85rem] font-semibold tabular">{amount(total)}</td>
            <td />
          </tr>
        </tbody>
      </table>
      {note}
    </div>
  );
}
