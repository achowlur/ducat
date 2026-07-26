"use client";

import { useState } from "react";
import { money } from "../../lib/ui/format";
import { axisMoney, niceTicks } from "./scale";

interface MonthValue {
  period: string;
  label: string;
  value: number;
  estimated: boolean;
  /** Unrealized investment movement for the month; null = no baseline. */
  marketGains: number | null;
}

const VIEW_W = 940;
const VIEW_H = 220;
const PLOT_TOP = 14;
const PLOT_BOTTOM = 186;
const PLOT_LEFT = 16;
const PLOT_RIGHT = 872;

/**
 * Net worth line: hairline grid, emphasized endpoint with a static label,
 * hover snaps to the nearest month with a crosshair and tooltip.
 */
export function NetWorthChart({ months }: { months: MonthValue[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  // Net worth is emitted only for periods where every account's balance is
  // known, so this list is legitimately empty until the first snapshot lands —
  // e.g. after a CSV-only import, which writes no snapshots. Every expression
  // below indexes months[], so bail before Math.max() of nothing yields
  // -Infinity and months[-1] throws.
  if (months.length === 0) {
    return (
      <p className="py-6 text-[0.85rem] text-faint">
        No month yet has a balance snapshot behind every account, so there is nothing to chart. Run a sync,
        or add month-end balances with <span className="font-money">npm run import:balances</span>.
      </p>
    );
  }

  const values = months.map((m) => m.value);
  const pad = (Math.max(...values) - Math.min(...values)) * 0.12 || 1;
  const ticks = niceTicks(Math.min(...values) - pad, Math.max(...values) + pad, 4);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v: number) => PLOT_BOTTOM - ((v - lo) / (hi - lo)) * (PLOT_BOTTOM - PLOT_TOP);
  const x = (i: number) =>
    months.length === 1 ? (PLOT_LEFT + PLOT_RIGHT) / 2 : PLOT_LEFT + ((PLOT_RIGHT - PLOT_LEFT) * i) / (months.length - 1);

  const points = months.map((m, i) => `${x(i).toFixed(1)},${y(m.value).toFixed(1)}`).join(" ");
  const last = months.length - 1;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    if (svgX < PLOT_LEFT - 10 || svgX > PLOT_RIGHT + 10) {
      setHovered(null);
      return;
    }
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < months.length; i++) {
      const d = Math.abs(x(i) - svgX);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    setHovered(nearest);
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full"
        role="img"
        aria-label="Net worth by month"
        onMouseMove={onMove}
        onMouseLeave={() => setHovered(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PLOT_LEFT} y1={y(t)} x2={PLOT_RIGHT} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={PLOT_RIGHT + 8} y={y(t) + 3} className="fill-[var(--faint)] font-money text-[10px]">
              {axisMoney(t)}
            </text>
          </g>
        ))}
        <line x1={PLOT_LEFT} y1={PLOT_BOTTOM} x2={PLOT_RIGHT} y2={PLOT_BOTTOM} stroke="var(--ink)" strokeWidth="1" />

        <polyline points={points} fill="none" stroke="var(--chart1)" strokeWidth="2" />

        {hovered !== null && (
          <line x1={x(hovered)} y1={PLOT_TOP} x2={x(hovered)} y2={PLOT_BOTTOM} stroke="var(--faint)" strokeWidth="1" strokeDasharray="3,3" />
        )}
        {hovered !== null && <circle cx={x(hovered)} cy={y(months[hovered].value)} r="4" fill="var(--chart1)" />}

        <circle cx={x(last)} cy={y(months[last].value)} r="3.5" fill="var(--chart1)" />
        {hovered === null && (
          <text x={x(last) - 10} y={y(months[last].value) - 10} textAnchor="end" className="fill-[var(--ink)] font-money text-[10.5px]">
            {money(months[last].value)}
          </text>
        )}

        {months.map((m, i) => (
          <text key={m.period} x={x(i)} y={PLOT_BOTTOM + 15} textAnchor="middle" className="fill-[var(--faint)] font-money text-[10px]">
            {m.label}
          </text>
        ))}
      </svg>
      {hovered !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-[3px] bg-ink px-2.5 py-1.5 font-money text-[0.7rem] text-paper"
          style={{
            left: `${Math.min(Math.max((x(hovered) / VIEW_W) * 100, 5), 80)}%`,
            top: `${Math.max((y(months[hovered].value) / VIEW_H) * 100 - 22, 0)}%`,
          }}
        >
          <div className="mb-0.5 text-[0.65rem] opacity-80">{months[hovered].label}</div>
          <div>
            {money(months[hovered].value)}
            {months[hovered].estimated ? " · partly estimated" : ""}
          </div>
          {months[hovered].marketGains !== null && months[hovered].marketGains !== 0 && (
            <div className="opacity-80">markets {money(months[hovered].marketGains)}</div>
          )}
        </div>
      )}
    </div>
  );
}
