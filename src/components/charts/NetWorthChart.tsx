"use client";

import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  isFull,
  panBy,
  pinchWindow,
  shownMonths,
  zoomAround,
  type ChartWindow,
} from "../../lib/ui/chartZoom";
import { money } from "../../lib/ui/format";
import { monthStep, monthTicks, yearLabels, yearSpans } from "../../lib/ui/timeAxis";
import { axisMoney, monthWithYear, niceTicks } from "./scale";

/** Room a month label needs, and a year label, in viewBox units at 10px type. */
const MONTH_LABEL = 34;
const YEAR_LABEL = 28;

interface MonthValue {
  period: string;
  label: string;
  value: number;
  estimated: boolean;
  /** Accounts the month leaves out (no value then): drawn as uncertain as an estimate is. */
  leftOut?: string[];
  /** Unrealized investment movement for the month; null = no baseline. */
  marketGains: number | null;
}

/** A month the reader must discount: an estimated value, or an account left out. */
function uncertain(m: MonthValue): boolean {
  return m.estimated || (m.leftOut?.length ?? 0) > 0;
}

/** Why a month is uncertain, in words, between the given brackets; empty when it is not. */
function qualifier(m: MonthValue, open: string, close: string): string {
  const parts = [
    ...(m.estimated ? ["partly estimated"] : []),
    ...((m.leftOut?.length ?? 0) > 0 ? [`leaves out ${m.leftOut?.length === 1 ? "1 account" : `${m.leftOut?.length} accounts`}`] : []),
  ];
  return parts.length === 0 ? "" : `${open}${parts.join(", ")}${close}`;
}

/**
 * Text inside a viewBox scales with the viewBox, so one geometry cannot serve
 * both widths: 940 units squeezed into a 327px phone renders 10px type at 4px.
 * Each breakpoint gets its own plot, sized so the scale factor stays near 1.
 *
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
 * hover or tap snaps to the nearest month with a crosshair and tooltip, and
 * the line zooms where the reader points (`window`, held by the card so the
 * figures above the chart can follow what it shows).
 */
export function NetWorthChart({
  months,
  window: shown,
  onWindow,
}: {
  months: MonthValue[];
  window: ChartWindow;
  onWindow: (w: ChartWindow) => void;
}) {
  // Net worth is emitted only for periods where some account's balance is
  // known, so this list is legitimately empty until the first snapshot lands —
  // e.g. after a CSV-only import, which writes no snapshots. Every expression
  // in Plot indexes months[], so bail before Math.max() of nothing yields
  // -Infinity and months[-1] throws.
  if (months.length === 0) {
    return (
      <p className="py-6 text-[0.85rem] text-faint">
        No month has a value behind any account yet, so there is nothing to chart. Run a sync, or add
        month-end balances with <span className="font-money">npm run import:balances</span>.
      </p>
    );
  }

  return (
    <>
      <div className="md:hidden">
        <Plot months={months} view={MOBILE} shown={shown} onWindow={onWindow} />
      </div>
      <div className="hidden md:block">
        <Plot months={months} view={DESKTOP} shown={shown} onWindow={onWindow} />
      </div>
    </>
  );
}

function Plot({
  months,
  view,
  shown,
  onWindow,
}: {
  months: MonthValue[];
  view: { w: number; h: number };
  shown: ChartWindow;
  onWindow: (w: ChartWindow) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();

  const VIEW_W = view.w;
  const VIEW_H = view.h;
  const PLOT_TOP = 14;
  const PLOT_BOTTOM = VIEW_H - 44;
  const PLOT_LEFT = 16;
  const PLOT_RIGHT = VIEW_W - 68; // room for the right-hand axis labels
  const PLOT_W = PLOT_RIGHT - PLOT_LEFT;

  const count = months.length;
  const last = count - 1;
  const span = Math.max(shown.end - shown.start, 1e-6);
  const { first: firstShown, last: lastShown } = shownMonths(shown);
  // The months that can reach the plot: those inside it and one either side,
  // whose segments run in from the edge (the clip trims them there).
  const lo = Math.max(0, Math.floor(shown.start));
  const hi = Math.min(last, Math.ceil(shown.end));

  // The scale fits the months on show, so zooming in reveals the moves a
  // whole-history axis flattens into a few pixels.
  const values = months.slice(lo, hi + 1).map((m) => m.value);
  // Six percent of headroom: twelve could push the top tick a whole step
  // above the line, a quarter of the plot drawn over nothing.
  const pad = (Math.max(...values) - Math.min(...values)) * 0.06 || 1;
  // Padding must not invent a NEGATIVE band no month reaches: a history that
  // starts near zero padded a "−$100k" tick under a line that never went below
  // zero. Below zero is drawn only when a month is.
  const bottom = Math.min(...values) >= 0 ? Math.max(0, Math.min(...values) - pad) : Math.min(...values) - pad;
  const ticks = niceTicks(bottom, Math.max(...values) + pad, 4);
  const yLo = ticks[0];
  const yHi = ticks[ticks.length - 1];
  const y = (v: number) => PLOT_BOTTOM - ((v - yLo) / (yHi - yLo)) * (PLOT_BOTTOM - PLOT_TOP);
  const x = (i: number) => (count === 1 ? (PLOT_LEFT + PLOT_RIGHT) / 2 : PLOT_LEFT + ((i - shown.start) / span) * PLOT_W);

  // The time axis. Months are named on CALENDAR steps (every month, every
  // other, quarters, halves) so moving along never makes a label hop, and the
  // newest month on show is always named, its nearest calendar label giving
  // way; when even halves would crowd, the axis names years alone. Labels sit
  // outside the clip and never print past an edge: the old axis cut a year
  // and "Oct" to fragments at the plot's edges.
  const unitsPerMonth = count < 2 ? PLOT_W : PLOT_W / span;
  const periods = months.map((m) => m.period);
  const step = monthStep(unitsPerMonth, MONTH_LABEL);
  const monthLabels = (() => {
    if (step === null) return [];
    const newest = lastShown;
    const room = MONTH_LABEL / unitsPerMonth;
    const calendar = monthTicks(periods, firstShown, lastShown, step).filter((i) => i === newest || newest - i >= room);
    return calendar.includes(newest) ? calendar : [...calendar, newest];
  })();
  const anchorAt = (px: number): "start" | "middle" | "end" =>
    px < PLOT_LEFT + 10 ? "start" : px > PLOT_RIGHT - 10 ? "end" : "middle";
  const spans = yearSpans(periods);
  const years = yearLabels(spans, shown, unitsPerMonth, YEAR_LABEL);
  // A year's left boundary, where one is on show: a hairline guide through
  // the plot and a tick through the label band.
  const boundaries = spans.filter((s) => s.start > 0 && s.start - 0.5 > shown.start && s.start - 0.5 < shown.end);
  const yearRow = step === null ? PLOT_BOTTOM + 15 : PLOT_BOTTOM + 29;
  // Every month gets a point only when the months are far enough apart to
  // read one: at full history a hollow point on nearly every month (most
  // were estimated) turned the line into a string of beads. Dense, a point marks only
  // an estimated month whose neighbours are not, which a dash cannot show.
  const pointsAll = unitsPerMonth >= 14;
  const isolated = (i: number) =>
    uncertain(months[i]) && (i === 0 || !uncertain(months[i - 1])) && (i === last || !uncertain(months[i + 1]));
  // A wash under the line only when the axis starts at zero: area reads as
  // amount, and over a cut axis it would overstate every month.
  const washed = yLo === 0 && count > 1;

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
  const segments = months.slice(lo + 1, hi + 1).map((m, k) => {
    const i = lo + k;
    return {
      key: m.period,
      x1: x(i),
      y1: y(months[i].value),
      x2: x(i + 1),
      y2: y(m.value),
      estimated: uncertain(months[i]) || uncertain(m),
    };
  });

  // Gestures read the latest window through a ref: they are attached once,
  // natively, because React's touch and wheel listeners are passive and could
  // not stop the page from zooming or scrolling under a pinch.
  const latest = useRef({ shown, count, onWindow });
  latest.current = { shown, count, onWindow };

  /** A client x as a place across the plot, 0 at its left edge and 1 at its right. */
  const across = (clientX: number, rect: DOMRect) =>
    Math.min(1, Math.max(0, (((clientX - rect.left) / rect.width) * VIEW_W - PLOT_LEFT) / PLOT_W));

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    let pinch: { from: ChartWindow; spread: number; anchor: number } | null = null;
    const spreadOf = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const midOf = (t: TouchList) => (t[0].clientX + t[1].clientX) / 2;

    // A trackpad pinch arrives as a wheel with ctrlKey set, so one handler
    // serves it and Ctrl + scroll. A plain wheel scrolls the page, never the
    // chart, or reading past it would zoom it; a sideways swipe moves along
    // the line once it is zoomed.
    const onWheel = (e: WheelEvent) => {
      const { shown: w, count: n, onWindow: set } = latest.current;
      if (n < 3) return;
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const rect = svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setHovered(null);
        set(zoomAround(w, Math.exp(e.deltaY * scale * 0.01), across(e.clientX, rect), n));
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !isFull(w, n)) {
        e.preventDefault();
        const perPx = (w.end - w.start) / ((rect.width * PLOT_W) / VIEW_W);
        set(panBy(w, e.deltaX * scale * perPx, n));
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      const { shown: w, count: n } = latest.current;
      if (e.touches.length === 2 && n >= 3) {
        pinch = { from: w, spread: spreadOf(e.touches), anchor: across(midOf(e.touches), svg.getBoundingClientRect()) };
        setHovered(null);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      const { count: n, onWindow: set } = latest.current;
      if (pinch === null || e.touches.length !== 2) return;
      // Two fingers belong to the chart: without this the page zooms too.
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      set(pinchWindow(pinch.from, pinch.spread, spreadOf(e.touches), pinch.anchor, across(midOf(e.touches), rect), n));
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };

    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("touchstart", onTouchStart, { passive: true });
    svg.addEventListener("touchmove", onTouchMove, { passive: false });
    svg.addEventListener("touchend", onTouchEnd);
    svg.addEventListener("touchcancel", onTouchEnd);
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("touchstart", onTouchStart);
      svg.removeEventListener("touchmove", onTouchMove);
      svg.removeEventListener("touchend", onTouchEnd);
      svg.removeEventListener("touchcancel", onTouchEnd);
    };
    // The handlers read everything that changes through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [VIEW_W, PLOT_W]);

  // Nearest shown month to a pointer, in viewBox units. Touch goes through the
  // same path as the mouse: without it a phone has no way to read any figure,
  // while the caption promises exact ones.
  const snapTo = (clientX: number, target: SVGSVGElement) => {
    const rect = target.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * VIEW_W;
    if (svgX < PLOT_LEFT - 10 || svgX > PLOT_RIGHT + 10) {
      setHovered(null);
      return;
    }
    let nearest = firstShown;
    let best = Infinity;
    for (let i = firstShown; i <= lastShown; i++) {
      const d = Math.abs(x(i) - svgX);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    setHovered(nearest);
  };

  // A mouse drags the zoomed line along; a press that does not move stays a
  // hover. Listening on the window keeps a drag that leaves the chart alive.
  const startDrag = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (e.button !== 0 || isFull(shown, count)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const from = shown;
    const startX = e.clientX;
    const perPx = (from.end - from.start) / ((rect.width * PLOT_W) / VIEW_W);
    let moved = false;
    const move = (ev: MouseEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      if (!moved) {
        moved = true;
        setDragging(true);
        setHovered(null);
      }
      onWindow(panBy(from, -(ev.clientX - startX) * perPx, count));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragging(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const summary = months.map((m) => `${m.label} ${money(m.value)}${qualifier(m, " (", ")")}`).join(", ");
  const point = hovered !== null && hovered >= firstShown && hovered <= lastShown ? hovered : null;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className={`w-full touch-pan-y select-none ${isFull(shown, count) ? "" : dragging ? "cursor-grabbing" : "cursor-grab"}`}
        role="img"
        aria-label={`Net worth by month: ${summary}`}
        onMouseMove={(e) => {
          if (!dragging) snapTo(e.clientX, e.currentTarget);
        }}
        onMouseLeave={() => setHovered(null)}
        onMouseDown={startDrag}
        onDoubleClick={() => onWindow({ start: 0, end: last })}
        onTouchStart={(e) => {
          if (e.touches.length === 1) snapTo(e.touches[0].clientX, e.currentTarget);
        }}
        onTouchMove={(e) => {
          if (e.touches.length === 1) snapTo(e.touches[0].clientX, e.currentTarget);
        }}
      >
        <defs>
          {/* The plot only: the line runs in from either edge and is trimmed
              there, while every label sits outside and is never cut. */}
          <clipPath id={clipId}>
            <rect x={PLOT_LEFT - 6} y={0} width={PLOT_W + 12} height={PLOT_BOTTOM + 6} />
          </clipPath>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PLOT_LEFT} y1={y(t)} x2={PLOT_RIGHT} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={PLOT_RIGHT + 8} y={y(t) + 3} className="fill-[var(--faint)] font-money text-[10px]">
              {axisMoney(t)}
            </text>
          </g>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {boundaries.map((s) => (
            <line
              key={`guide-${s.year}`}
              x1={x(s.start - 0.5)}
              y1={PLOT_TOP}
              x2={x(s.start - 0.5)}
              y2={PLOT_BOTTOM}
              stroke="var(--grid)"
              strokeWidth="1"
            />
          ))}
          {washed && (
            <path
              d={`M${x(lo)},${PLOT_BOTTOM} ${months
                .slice(lo, hi + 1)
                .map((m, k) => `L${x(lo + k)},${y(m.value)}`)
                .join(" ")} L${x(hi)},${PLOT_BOTTOM} Z`}
              fill="var(--chart1)"
              fillOpacity="0.08"
            />
          )}
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
          {/* A hollow point marks an estimated month a dash cannot show (one
              with no estimated neighbour); zoomed in, every month gets a
              point, filled when known and hollow when estimated. */}
          {months.slice(lo, hi + 1).map((m, k) => {
            const i = lo + k;
            if (i === last || !(pointsAll || isolated(i))) return null;
            const hollow = uncertain(m);
            return (
              <circle
                key={`pt-${m.period}`}
                cx={x(i)}
                cy={y(m.value)}
                r={hollow ? 2.5 : 2.25}
                fill={hollow ? "var(--paper)" : "var(--chart1)"}
                stroke="var(--chart1)"
                strokeWidth={hollow ? 1.5 : 0}
              />
            );
          })}

          {point !== null && (
            <line x1={x(point)} y1={PLOT_TOP} x2={x(point)} y2={PLOT_BOTTOM} stroke="var(--faint)" strokeWidth="1" strokeDasharray="3,3" />
          )}
          {point !== null && (
            <circle cx={x(point)} cy={y(months[point].value)} r="4.5" fill="var(--chart1)" stroke="var(--paper)" strokeWidth="2" />
          )}

          {/* The newest month, ringed in the paper colour so it stays a dot
              where it sits on the line. */}
          {lastShown === last && (
            <circle cx={x(last)} cy={y(months[last].value)} r="4.5" fill="var(--chart1)" stroke="var(--paper)" strokeWidth="2" />
          )}
        </g>
        <line x1={PLOT_LEFT} y1={PLOT_BOTTOM} x2={PLOT_RIGHT} y2={PLOT_BOTTOM} stroke="var(--ink)" strokeWidth="1" />

        {boundaries.map((s) => (
          <line
            key={`tick-${s.year}`}
            x1={x(s.start - 0.5)}
            y1={PLOT_BOTTOM}
            x2={x(s.start - 0.5)}
            y2={yearRow + 3}
            stroke="var(--rule)"
            strokeWidth="1"
          />
        ))}
        {monthLabels.map((i) => (
          <text
            key={`m-${months[i].period}`}
            x={x(i)}
            y={PLOT_BOTTOM + 15}
            textAnchor={anchorAt(x(i))}
            className="fill-[var(--faint)] font-money text-[10px]"
          >
            {months[i].label}
          </text>
        ))}
        {years.map((l) => (
          <text
            key={`y-${l.year}`}
            x={Math.min(PLOT_RIGHT - 12, Math.max(PLOT_LEFT + 12, x(l.at)))}
            y={yearRow}
            textAnchor="middle"
            className="fill-[var(--faint)] font-money text-[10px] font-semibold"
          >
            {l.year}
          </text>
        ))}
        {point === null && lastShown === last && (
          <text x={x(last) - 10} y={y(months[last].value) - 10} textAnchor="end" className="fill-[var(--ink)] font-money text-[10.5px]">
            {money(months[last].value)}
          </text>
        )}
      </svg>
      {point !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-[3px] bg-ink px-2.5 py-1.5 font-money text-[0.7rem] text-paper"
          style={{
            left: `${Math.min(Math.max((x(point) / VIEW_W) * 100, 5), 80)}%`,
            top: `${Math.max((y(months[point].value) / VIEW_H) * 100 - 22, 0)}%`,
          }}
        >
          <div className="mb-0.5 text-[0.65rem] opacity-80">{monthWithYear(months[point].period)}</div>
          <div>
            {money(months[point].value)}
            {qualifier(months[point], " · ", "")}
          </div>
          {months[point].marketGains !== null && months[point].marketGains !== 0 && (
            <div className="opacity-80">markets {money(months[point].marketGains)}</div>
          )}
        </div>
      )}
    </div>
  );
}
