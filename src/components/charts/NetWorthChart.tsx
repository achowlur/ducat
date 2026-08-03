"use client";

import { useState } from "react";
import { money } from "../../lib/ui/format";
import { axisMoney, labelStepFor, monthWithYear, niceTicks } from "./scale";

interface MonthValue {
  period: string;
  label: string;
  value: number;
  estimated: boolean;
  /** Unrealized investment movement for the month; null = no baseline. */
  marketGains: number | null;
}

/**
 * Text inside a viewBox scales with the viewBox, so one geometry cannot serve
 * both widths: 940 units squeezed into a 327px phone renders 10px type at 4px.
 * Each breakpoint gets its own plot, sized so the scale factor stays near 1.
 */
/**
 * Desktop is deliberately taller than wide-and-flat. At 220 the plot area was
 * ~170px for a range that spans tens of thousands, so a real month-to-month
 * move rendered as a few pixels and the line read as almost flat — the shape
 * of the data was being hidden by the aspect ratio rather than by the numbers.
 * Mobile keeps its own height: it is already narrow, so the line is steep
 * enough without help.
 */
const DESKTOP = { w: 940, h: 320 };
const MOBILE = { w: 340, h: 250 };

/**
 * Net worth line: hairline grid, emphasized endpoint with a static label,
 * hover or tap snaps to the nearest month with a crosshair and tooltip.
 */
export function NetWorthChart({ months }: { months: MonthValue[] }) {
  // Net worth is emitted only for periods where every account's balance is
  // known, so this list is legitimately empty until the first snapshot lands —
  // e.g. after a CSV-only import, which writes no snapshots. Every expression
  // in Plot indexes months[], so bail before Math.max() of nothing yields
  // -Infinity and months[-1] throws.
  if (months.length === 0) {
    return (
      <p className="py-6 text-[0.85rem] text-faint">
        No month yet has a balance snapshot behind every account, so there is nothing to chart. Run a sync,
        or add month-end balances with <span className="font-money">npm run import:balances</span>.
      </p>
    );
  }

  return (
    <>
      <div className="md:hidden">
        <Plot months={months} view={MOBILE} />
      </div>
      <div className="hidden md:block">
        <Plot months={months} view={DESKTOP} />
      </div>
    </>
  );
}

function Plot({ months, view }: { months: MonthValue[]; view: { w: number; h: number } }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const VIEW_W = view.w;
  const VIEW_H = view.h;
  const PLOT_TOP = 14;
  const PLOT_BOTTOM = VIEW_H - 44;
  const PLOT_LEFT = 16;
  const PLOT_RIGHT = VIEW_W - 68; // room for the right-hand axis labels

  const values = months.map((m) => m.value);
  const pad = (Math.max(...values) - Math.min(...values)) * 0.12 || 1;
  const ticks = niceTicks(Math.min(...values) - pad, Math.max(...values) + pad, 4);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v: number) => PLOT_BOTTOM - ((v - lo) / (hi - lo)) * (PLOT_BOTTOM - PLOT_TOP);
  const x = (i: number) =>
    months.length === 1 ? (PLOT_LEFT + PLOT_RIGHT) / 2 : PLOT_LEFT + ((PLOT_RIGHT - PLOT_LEFT) * i) / (months.length - 1);

  const last = months.length - 1;
  const labelStep = labelStepFor(
    months.length < 2 ? PLOT_RIGHT - PLOT_LEFT : (PLOT_RIGHT - PLOT_LEFT) / (months.length - 1),
    34,
  );
  const yearOf = (i: number) => months[i].period.slice(0, 4);
  const yearStarts = months.map((_, i) => i).filter((i) => i === 0 || yearOf(i) !== yearOf(i - 1));
  const yearSpans = yearStarts.map((start, n) => ({
    year: yearOf(start),
    start,
    end: n + 1 < yearStarts.length ? yearStarts[n + 1] - 1 : last,
  }));

  // The caption told the reader to look for "months marked estimated" and
  // nothing was marked: one solid confident line, the flag reachable only by
  // hovering each point in turn — six separate hovers to learn that six of
  // seven months lack a snapshot for at least one account. A line you cannot
  // discount at a glance is one you read as fully known.
  //
  // Drawn as per-segment lines rather than one polyline so a segment touching
  // an estimated month can be dashed. Estimated months are contiguous today
  // (the snapshot era began mid-history) but need not be, so the test is
  // per-segment, not a single boundary index.
  const segments = months.slice(1).map((m, i) => ({
    key: m.period,
    x1: x(i),
    y1: y(months[i].value),
    x2: x(i + 1),
    y2: y(m.value),
    estimated: months[i].estimated || m.estimated,
  }));

  // Nearest month to a pointer, in viewBox units. Touch goes through the same
  // path as the mouse: without it a phone has no way to read any figure, while
  // the caption promises exact ones.
  const snapTo = (clientX: number, target: SVGSVGElement) => {
    const rect = target.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * VIEW_W;
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

  const summary = months
    .map((m) => `${m.label} ${money(m.value)}${m.estimated ? " (partly estimated)" : ""}`)
    .join(", ");

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full touch-pan-y"
        role="img"
        aria-label={`Net worth by month: ${summary}`}
        onMouseMove={(e) => snapTo(e.clientX, e.currentTarget)}
        onMouseLeave={() => setHovered(null)}
        onTouchStart={(e) => snapTo(e.touches[0].clientX, e.currentTarget)}
        onTouchMove={(e) => snapTo(e.touches[0].clientX, e.currentTarget)}
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

        {segments.map((s) => (
          <line
            key={s.key}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke="var(--chart1)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={s.estimated ? "5,3" : undefined}
          />
        ))}
        {/* A hollow point on each estimated month, so the mark survives a
            single estimated month with no neighbour to dash against. */}
        {months.map((m, i) =>
          m.estimated ? (
            <circle
              key={`est-${m.period}`}
              cx={x(i)}
              cy={y(m.value)}
              r="2.5"
              fill="var(--paper)"
              stroke="var(--chart1)"
              strokeWidth="1.5"
            />
          ) : null,
        )}

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

        {/* Year band + thinned labels, the treatment the cash-flow axis has
            had since the 26-month squeeze. This axis grows with history too and
            had neither: it labelled every month unconditionally, which was
            comfortable at seven points and stops being so at thirteen — mobile
            spacing is 246/(n−1) against 17-18px labels, touching at n=13. The
            series began 2026-01 and gains a point a month, so that is January
            2027, i.e. this was a dated bug rather than a hypothetical one. */}
        {months.map((m, i) =>
          (last - i) % labelStep === 0 ? (
            <text key={m.period} x={x(i)} y={PLOT_BOTTOM + 15} textAnchor="middle" className="fill-[var(--faint)] font-money text-[10px]">
              {m.label}
            </text>
          ) : null,
        )}
        {yearSpans.map((s) => (
          <g key={s.year}>
            {s.start > 0 && (
              <line
                x1={(x(s.start) + x(s.start - 1)) / 2}
                y1={PLOT_TOP}
                x2={(x(s.start) + x(s.start - 1)) / 2}
                y2={PLOT_BOTTOM + 19}
                stroke="var(--rule)"
                strokeWidth="1"
              />
            )}
            <text
              x={(x(s.start) + x(s.end)) / 2}
              y={PLOT_BOTTOM + 29}
              textAnchor="middle"
              className="fill-[var(--faint)] font-money text-[10px] font-semibold"
            >
              {s.year}
            </text>
          </g>
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
          <div className="mb-0.5 text-[0.65rem] opacity-80">{monthWithYear(months[hovered].period)}</div>
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
