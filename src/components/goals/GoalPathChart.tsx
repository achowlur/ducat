"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { axisMoney } from "../charts/scale";
import { money, monthLabel } from "../../lib/ui/format";
import { addMonths } from "../../lib/ui/netWorthGoal";
import { goalAxisTicks } from "../../lib/ui/timeAxis";

/**
 * A goal's path: what happened (solid, in ink), then each projection (dashed:
 * a forecast, never an observation), each in its colour and ending with a dot
 * where it reaches the target line. The goal's date band above the chart is
 * its legend, in the same colours, so no date is printed twice.
 *
 * Tap or point anywhere along it for that month's figures: the record for a
 * month that happened, each projection's value for one that has not. Touch
 * is the device this is read on, so the readout follows a finger (a drag
 * across the chart moves it; scrolling up and down still scrolls the page).
 *
 * Two geometries, as NetWorthChart has: type inside a viewBox scales with it,
 * and one width cannot serve a phone and a desktop.
 */

const DESKTOP = { w: 640, h: 190 };
const MOBILE = { w: 340, h: 170 };
const PAD = { left: 8, right: 10, top: 18, bottom: 22 };

export interface GoalProjectionLine {
  /** What the readout calls it: "By saving alone". */
  label: string;
  color: "chart1" | "chart2";
  /** Month by month from the anchor (index 0 is the anchor month). */
  values: number[];
  /** Months from the anchor to where it reaches the target; null when it never does in view. */
  lands: number | null;
}

interface Props {
  /** What happened, oldest first. */
  recent: { period: string; value: number }[];
  /** What the record line is called in the readout: "Net worth", "Saved". */
  recentLabel: string;
  /** The month the projections start from. */
  anchor: string;
  projections: GoalProjectionLine[];
  target: number;
}

function monthIndex(key: string): number {
  return Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
}

/** Everything both geometries share, worked out once. */
function layout({ recent, anchor, projections, target }: Props) {
  const start = recent.length > 0 && recent[0].period < anchor ? recent[0].period : anchor;
  const anchorAt = monthIndex(anchor) - monthIndex(start);
  const ahead = Math.max(1, ...projections.map((p) => p.values.length - 1));
  const total = anchorAt + ahead;
  const top = Math.max(target, ...recent.map((r) => r.value)) * 1.06;
  const bottom = Math.min(0, ...recent.map((r) => r.value));
  return { start, anchorAt, ahead, total, top, bottom };
}

function Plot({
  size,
  props,
  active,
  onActive,
}: {
  size: { w: number; h: number };
  props: Props;
  active: number | null;
  onActive: (i: number | null) => void;
}) {
  const { recent, anchor, projections, target } = props;
  const { start, anchorAt, ahead, total, top, bottom } = layout(props);
  const svgRef = useRef<SVGSVGElement>(null);
  const plotW = size.w - PAD.left - PAD.right;
  const x = (i: number) => PAD.left + (i / Math.max(1, total)) * plotW;
  const y = (v: number) => size.h - PAD.bottom - ((v - bottom) / (top - bottom)) * (size.h - PAD.top - PAD.bottom);
  const line = (points: [number, number][]) =>
    points.map(([px, py], k) => `${k === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");

  const history = recent.map((r) => [x(monthIndex(r.period) - monthIndex(start)), y(r.value)] as [number, number]);
  const projected = (values: number[]) => values.map((v, t) => [x(anchorAt + t), y(Math.min(v, top))] as [number, number]);

  // Quarters on a short chart, calendar years on a long one (goalAxisTicks).
  const ticks = goalAxisTicks(start, addMonths(anchor, ahead));

  // The pointer's month, in whole months from the chart's first.
  const indexAt = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return null;
    const vx = ((e.clientX - rect.left) / rect.width) * size.w;
    return Math.min(total, Math.max(0, Math.round(((vx - PAD.left) / plotW) * total)));
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${size.w} ${size.h}`}
      className="block h-auto w-full touch-pan-y select-none"
      role="img"
      aria-label="The record so far, and the projected paths to the target"
      onPointerDown={(e) => onActive(indexAt(e))}
      onPointerMove={(e) => {
        // A mouse reads on hover; a finger only while it is down.
        if (e.pointerType === "mouse" || e.buttons > 0) onActive(indexAt(e));
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") onActive(null);
      }}
    >
      <title>The record so far, and the projected paths to the target</title>
      <line x1={PAD.left} x2={size.w - PAD.right} y1={y(target)} y2={y(target)} stroke="var(--faint)" strokeWidth="1" strokeDasharray="2,3" />
      <text x={PAD.left} y={y(target) - 5} fontSize="10" fill="var(--faint)">
        {axisMoney(target)} goal
      </text>
      <line x1={PAD.left} x2={size.w - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--rule)" strokeWidth="1" />
      {ticks.map((tick) => (
        <g key={tick.at}>
          <line x1={x(tick.at)} x2={x(tick.at)} y1={y(0)} y2={y(0) + 3} stroke="var(--rule)" />
          <text x={x(tick.at)} y={size.h - 6} fontSize="10" textAnchor="middle" fill="var(--faint)">
            {tick.label}
          </text>
        </g>
      ))}
      {/* Where the record ends and the projections begin. */}
      <line x1={x(anchorAt)} x2={x(anchorAt)} y1={PAD.top} y2={y(0)} stroke="var(--grid)" strokeWidth="1" />
      {[...projections].reverse().map((p) => (
        <path key={p.label} d={line(projected(p.values))} fill="none" stroke={`var(--${p.color})`} strokeWidth="2" strokeDasharray="5,3" />
      ))}
      {history.length > 1 && <path d={line(history)} fill="none" stroke="var(--ink)" strokeWidth="2" />}
      {projections.map(
        (p) =>
          p.lands !== null && (
            <circle key={p.label} cx={x(anchorAt + p.lands)} cy={y(target)} r="4" fill={`var(--${p.color})`} stroke="var(--paper)" strokeWidth="2" />
          ),
      )}
      {history.length > 0 && (
        <circle cx={history[history.length - 1][0]} cy={history[history.length - 1][1]} r="3.5" fill="var(--ink)" stroke="var(--paper)" strokeWidth="2" />
      )}
      {active !== null && (
        <line x1={x(active)} x2={x(active)} y1={PAD.top - 6} y2={y(0)} stroke="var(--faint)" strokeWidth="1" strokeDasharray="3,3" />
      )}
      {/* A generous hit area: the whole plot, not the 2px lines. */}
      <rect x={0} y={0} width={size.w} height={size.h} fill="transparent" />
    </svg>
  );
}

export function GoalPathChart(props: Props) {
  const [active, setActive] = useState<number | null>(null);
  const { start, anchorAt, total } = layout(props);

  // The readout: the record for a month that happened, each projection's
  // value for one that has not. Positioned over the month, kept inside.
  let readout: { period: string; left: number; rows: { label: string; color: string | null; value: number }[] } | null = null;
  if (active !== null) {
    const period = addMonths(start, active);
    const rows: { label: string; color: string | null; value: number }[] = [];
    if (active <= anchorAt) {
      const record = props.recent.find((r) => r.period === period);
      if (record !== undefined) rows.push({ label: props.recentLabel, color: null, value: record.value });
    }
    if (active >= anchorAt && rows.length === 0) {
      for (const p of props.projections) {
        const t = active - anchorAt;
        if (t < p.values.length) rows.push({ label: p.label, color: p.color, value: p.values[t] });
      }
    }
    if (rows.length > 0) readout = { period, left: (active / Math.max(1, total)) * 100, rows };
  }

  return (
    <div className="relative max-w-[640px]">
      <div className="hidden md:block">
        <Plot size={DESKTOP} props={props} active={active} onActive={setActive} />
      </div>
      <div className="md:hidden">
        <Plot size={MOBILE} props={props} active={active} onActive={setActive} />
      </div>
      {readout !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-[2px] border border-rule bg-paper px-2 py-1 text-[0.72rem] shadow-sm"
          style={
            readout.left > 60
              ? { right: `${100 - readout.left}%`, marginRight: 8 }
              : { left: `${readout.left}%`, marginLeft: 8 }
          }
        >
          <div className="whitespace-nowrap font-semibold">
            {monthLabel(readout.period)}
            {active !== null && active > anchorAt && <span className="font-normal text-faint"> · projected</span>}
          </div>
          {readout.rows.map((r) => (
            <div key={r.label} className="flex items-center gap-1.5 whitespace-nowrap">
              <span
                aria-hidden
                className={`inline-block h-[8px] w-[8px] rounded-[2px] ${r.color === "chart1" ? "bg-chart1" : r.color === "chart2" ? "bg-chart2" : "bg-ink"}`}
              />
              <span className="text-faint">{r.label}</span>
              <span className="font-money tabular">
                {active !== null && active > anchorAt ? "~" : ""}
                {money(r.value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
