"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { money } from "../../../lib/ui/format";
import { axisMoney, labelStepFor, niceTicks } from "../scale";

export interface TimeSeries {
  name: string;
  /** A CSS colour, normally a theme variable. */
  color: string;
  /** One value per point; null where nothing can be said (not yet, or before the records). */
  values: (number | null)[];
  /** The thing compared AGAINST: drawn dashed as a line, faded as bars. */
  muted?: boolean;
}

export interface TimeChartProps {
  kind: "line" | "bars" | "stacked";
  /** Axis label per point: "Jul", "3". */
  labels: string[];
  /** The readout's heading per point: "Jul 2026", "Oct 3". */
  headings: string[];
  /** A year per point draws the year band (any axis that grows with history). */
  years?: string[];
  series: TimeSeries[];
  /** A range each point is judged against; the readout names where the first series falls in it. */
  band?: { low: number[]; high: number[] };
  /**
   * Bars taller than this run off the top and are marked rather than allowed
   * to flatten everything else (rent landing on the 1st, against a month of
   * $40 days).
   */
  cap?: number;
  /** The point the readout opens on: the newest one with something to say. */
  initial: number;
  ariaLabel: string;
  /**
   * How many points a phone fits before the strip scrolls. A month of DAYS is
   * read whole, today against the rest of it; a long history scrolls.
   */
  phoneFit?: number;
  /**
   * The first series' figure at the chosen point is the CARD's answer, drawn
   * as Ducat draws one (a money-face figure over a line of context) and
   * moving with the chosen point.
   */
  hero?: boolean;
}

/** Below this many points a phone fits the whole axis; above it the strip scrolls, opened at today. */
const PHONE_FIT = 13;
/** Phone geometry is sized near its rendered width so 11px type renders near 11px. */
const PHONE = { w: 340, h: 230, perPoint: 24 };
/** Desktop stops at 880px: past it the viewBox scales type larger than the prose (ui-and-pages.md). */
const DESKTOP = { w: 880, h: 290 };

const PAD = { left: 6, right: 52, top: 12, bottom: 40 };

/**
 * One time axis, drawn as lines, side-by-side bars or stacked bars. The
 * figures live in a READOUT above the plot rather than a floating tooltip:
 * a phone has no hover, a tooltip clips at the edge of a scroller, and the
 * one figure a screen exists for must be on screen before anyone taps. Tap,
 * hover or arrow keys move it. The readout is also the LEGEND: each series'
 * swatch sits beside its figure, so nothing below the plot repeats it.
 */
export function TimeChart(props: TimeChartProps) {
  const n = props.labels.length;
  const clamp = (i: number) => Math.min(Math.max(i, 0), Math.max(n - 1, 0));
  const [selected, setSelected] = useState(clamp(props.initial));
  // New data (another span, another measure) reopens the readout on ITS
  // newest point; a tap survives anything else.
  const [anchor, setAnchor] = useState({ initial: props.initial, n });
  if (anchor.initial !== props.initial || anchor.n !== n) {
    setAnchor({ initial: props.initial, n });
    setSelected(clamp(props.initial));
  }
  const strip = useRef<HTMLDivElement | null>(null);
  // A scrolling strip opens where the reader is needed: on the point the
  // readout opened on, which for a history is today, at its end.
  const initialAt = props.initial;
  useEffect(() => {
    const box = strip.current;
    if (box !== null) box.scrollLeft = (box.scrollWidth - box.clientWidth) * (n > 1 ? initialAt / (n - 1) : 1);
  }, [n, initialAt]);

  if (n === 0) {
    return <p className="py-6 text-[0.85rem] text-faint">No months to draw yet.</p>;
  }
  const at = Math.min(selected, n - 1);
  const scale = scaleOf(props);
  const clipped = props.kind === "bars" && props.series.some((s) => s.values.some((v) => v !== null && v > scale.hi));
  const phoneW = n > (props.phoneFit ?? PHONE_FIT) ? Math.max(PHONE.w, n * PHONE.perPoint) : PHONE.w;

  return (
    <div>
      <ChartReadout
        heading={props.headings[at]}
        series={props.series}
        kind={props.kind}
        band={props.band}
        index={at}
        hero={props.hero}
      />
      <div ref={strip} className="scroll-x md:hidden">
        <div style={{ width: phoneW }}>
          <Plot {...props} w={phoneW} h={PHONE.h} selected={at} onSelect={setSelected} scale={scale} />
        </div>
      </div>
      <div className="hidden max-w-[880px] md:block">
        <Plot {...props} w={DESKTOP.w} h={DESKTOP.h} selected={at} onSelect={setSelected} scale={scale} />
      </div>
      {clipped && (
        <p className="mt-1 text-[0.72rem] text-faint">
          Bars above {money(scale.hi)} run off the scale and print their own figure; tap one for its exact amount.
        </p>
      )}
    </div>
  );
}

function Swatch({ color, muted = false, line }: { color: string; muted?: boolean; line: boolean }) {
  return line ? (
    <i
      className="mr-1.5 inline-block w-4 align-[3px]"
      style={muted ? { borderTop: `2px dashed ${color}` } : { height: 3, background: color }}
    />
  ) : (
    <i
      className="mr-1.5 inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]"
      style={{ background: color, opacity: muted ? 0.45 : 1 }}
    />
  );
}

/** A figure inside the readout's line of context, as Overview sets one. */
function Fig({ value }: { value: number | null }) {
  return (
    <span className="whitespace-nowrap font-money font-semibold tabular text-ink">
      {value === null ? "not yet" : money(value)}
    </span>
  );
}

/**
 * One point's figures, each beside the swatch of the mark it describes. A
 * table view renders it too, fixed on the point the chart would open on, so
 * the card states its answer in the same place whichever view is chosen.
 */
export function ChartReadout({
  heading,
  series,
  kind,
  band,
  index,
  hero = false,
}: {
  heading: string;
  series: TimeSeries[];
  kind: TimeChartProps["kind"];
  band?: TimeChartProps["band"];
  index: number;
  hero?: boolean;
}) {
  const together = kind === "stacked" ? series.reduce((s, x) => s + (x.values[index] ?? 0), 0) : null;
  const lead = series[0]?.values[index] ?? null;
  const verdict =
    band === undefined || lead === null
      ? null
      : lead < band.low[index]
        ? "below typical"
        : lead > band.high[index]
          ? "above typical"
          : "within typical";
  const line = kind === "line";
  const context = (
    <p
      className={`flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[0.78rem] text-faint ${hero ? "mt-1" : "mb-2 min-h-[1.6em]"}`}
      aria-live="polite"
    >
      <span className="font-semibold text-ink">{heading}</span>
      {together !== null && (
        <span className="whitespace-nowrap">
          together <Fig value={together} />
        </span>
      )}
      {series.map((s, i) => (
        <span key={s.name} className="whitespace-nowrap">
          <Swatch color={s.color} muted={s.muted} line={line} />
          {s.name}
          {!(hero && i === 0) && (
            <>
              {" "}
              <Fig value={s.values[index]} />
            </>
          )}
          {i === 0 && verdict !== null && (
            <>
              , <span className="text-ink">{verdict}</span>
            </>
          )}
        </span>
      ))}
      {band !== undefined && (
        <span className="whitespace-nowrap">
          <i className="mr-1.5 inline-block h-[9px] w-4 align-[-1px]" style={{ background: "var(--rule)" }} />
          typical <Fig value={band.low[index]} /> to <Fig value={band.high[index]} />
        </span>
      )}
    </p>
  );
  if (!hero) return context;
  return (
    <div className="mb-3">
      <div className={`font-money text-[1.25rem] leading-tight tabular ${lead === null ? "text-faint" : ""}`}>
        {lead === null ? "not yet" : money(lead)}
      </div>
      {context}
    </div>
  );
}

interface Scale {
  ticks: number[];
  lo: number;
  hi: number;
}

/** One scale for both geometries: it depends on the values, never on the width. */
function scaleOf({ kind, labels, series, band, cap }: TimeChartProps): Scale {
  const values: number[] = [];
  if (kind === "stacked") {
    for (let i = 0; i < labels.length; i += 1) values.push(series.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0));
  } else {
    for (const s of series) for (const v of s.values) if (v !== null) values.push(v);
  }
  if (band !== undefined) values.push(...band.high, ...band.low);
  const rawMax = Math.max(0, ...values);
  const max = cap !== undefined && cap < rawMax ? cap : rawMax;
  const min = Math.min(0, ...values);
  const ticks = niceTicks(min, max === min ? min + 1 : max * 1.04, 4);
  return { ticks, lo: ticks[0], hi: ticks[ticks.length - 1] };
}

function Plot(
  props: TimeChartProps & { w: number; h: number; selected: number; onSelect: (i: number) => void; scale: Scale },
) {
  const { kind, labels, series, band, w, h, selected, onSelect, scale } = props;
  const n = labels.length;
  const left = PAD.left;
  const right = w - PAD.right;
  const top = PAD.top;
  const bottom = h - PAD.bottom;

  // Every value the scale must hold. Stacks hold their positive sums.
  const { ticks, lo, hi } = scale;
  const y = (v: number) => bottom - ((Math.min(v, hi) - lo) / (hi - lo)) * (bottom - top);

  // Lines put points on the ends; bars put them in slots.
  const slot = (right - left) / n;
  const x =
    kind === "line"
      ? (i: number) => (n === 1 ? (left + right) / 2 : left + (i / (n - 1)) * (right - left))
      : (i: number) => left + slot * i + slot / 2;
  const spacing = kind === "line" ? (right - left) / Math.max(n - 1, 1) : slot;
  const longest = Math.max(...labels.map((l) => l.length));
  const step = labelStepFor(spacing, longest * 6.4 + 8);
  const labelled = (i: number) => (n - 1 - i) % step === 0;

  const pick = (clientX: number, rect: DOMRect) => {
    const ux = ((clientX - rect.left) / rect.width) * w;
    const i = kind === "line" ? Math.round(((ux - left) / (right - left)) * (n - 1)) : Math.floor((ux - left) / slot);
    onSelect(Math.min(Math.max(i, 0), n - 1));
  };
  const onMove = (e: MouseEvent<SVGRectElement>) => pick(e.clientX, e.currentTarget.getBoundingClientRect());
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowLeft") onSelect(Math.max(selected - 1, 0));
    else if (e.key === "ArrowRight") onSelect(Math.min(selected + 1, n - 1));
    else return;
    e.preventDefault();
  };

  // Year band: where each year begins, for the divider and its caption.
  const years = props.years;
  const yearSpans: { year: string; start: number; end: number }[] = [];
  if (years !== undefined) {
    years.forEach((yr, i) => {
      const last = yearSpans[yearSpans.length - 1];
      if (last === undefined || last.year !== yr) yearSpans.push({ year: yr, start: i, end: i });
      else last.end = i;
    });
  }

  const k = series.length;
  const barW = Math.max(1.5, Math.min(18, (slot * 0.76) / (kind === "stacked" ? 1 : k)));

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="block w-full outline-none focus-visible:ring-1 focus-visible:ring-acc"
      role="img"
      aria-label={props.ariaLabel}
      tabIndex={0}
      onKeyDown={onKey}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--ink)" : "var(--grid)"} strokeWidth="1" />
          <text x={right + 8} y={y(t) + 3} className="fill-[var(--faint)] font-money text-[10px]">
            {axisMoney(t)}
          </text>
        </g>
      ))}

      {band !== undefined && (
        <polygon
          points={band.low
            .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
            .concat(band.high.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse())
            .join(" ")}
          fill="var(--rule)"
          fillOpacity="0.75"
        />
      )}

      {yearSpans.map((s) => {
        const startX = kind === "line" ? x(s.start) : left + slot * s.start;
        const endX = kind === "line" ? x(s.end) : left + slot * (s.end + 1);
        return (
          <g key={s.year}>
            {s.start > 0 && (
              <line x1={startX} x2={startX} y1={top} y2={bottom + 30} stroke="var(--rule)" strokeWidth="1" />
            )}
            <text
              x={(startX + endX) / 2}
              y={bottom + 32}
              textAnchor="middle"
              className="fill-[var(--faint)] font-money text-[10px] font-semibold"
            >
              {s.year}
            </text>
          </g>
        );
      })}

      {kind === "line" &&
        series.map((s) => {
          // Broken at nulls: a month not complete yet is not a month at zero.
          const runs: string[] = [];
          let current: string[] = [];
          s.values.forEach((v, i) => {
            if (v === null) {
              if (current.length > 0) runs.push(current.join(" L"));
              current = [];
            } else current.push(`${x(i).toFixed(1)} ${y(v).toFixed(1)}`);
          });
          if (current.length > 0) runs.push(current.join(" L"));
          const lastIdx = s.values.reduce<number>((acc, v, i) => (v === null ? acc : i), -1);
          return (
            <g key={s.name}>
              {runs.map((r) => (
                <path
                  key={r}
                  d={`M${r}`}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.muted ? 1.5 : 2}
                  strokeDasharray={s.muted ? "5,3" : undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
              {!s.muted && lastIdx >= 0 && (
                <circle cx={x(lastIdx)} cy={y(s.values[lastIdx] as number)} r="3.5" fill={s.color} />
              )}
            </g>
          );
        })}

      {kind === "bars" &&
        series.map((s, si) =>
          s.values.map((v, i) => {
            if (v === null) return null;
            const bx = x(i) - (k * barW) / 2 + si * barW;
            const top0 = v >= 0 ? y(v) : y(0);
            const height = Math.max(Math.abs(y(v) - y(0)), v === 0 ? 0 : 1);
            const clipped = v > hi;
            return (
              <g key={`${s.name}-${i}`}>
                <rect
                  x={bx}
                  y={top0}
                  width={Math.max(1, barW - 1)}
                  height={height}
                  rx="2"
                  fill={s.color}
                  opacity={s.muted ? 0.45 : 1}
                />
                {clipped && (
                  <text
                    x={bx + barW / 2}
                    y={top - 2}
                    textAnchor="middle"
                    className="fill-[var(--ink)] font-money text-[10px]"
                  >
                    ▲{axisMoney(v)}
                  </text>
                )}
              </g>
            );
          }),
        )}

      {kind === "stacked" &&
        labels.map((_, i) => {
          let base = 0;
          return (
            <g key={i}>
              {series.map((s) => {
                const v = Math.max(0, s.values[i] ?? 0);
                const y1 = y(base + v);
                const y0 = y(base);
                base += v;
                return v === 0 ? null : (
                  <rect key={s.name} x={x(i) - barW / 2} y={y1} width={barW} height={Math.max(0, y0 - y1)} fill={s.color} />
                );
              })}
            </g>
          );
        })}

      {labels.map((l, i) =>
        labelled(i) ? (
          <text key={i} x={x(i)} y={bottom + 15} textAnchor="middle" className="fill-[var(--faint)] font-money text-[10px]">
            {l}
          </text>
        ) : null,
      )}

      <line x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} stroke="var(--faint)" strokeWidth="1" strokeDasharray="3,3" />
      {kind === "line" &&
        series.map((s) =>
          s.values[selected] === null ? null : (
            <circle key={s.name} cx={x(selected)} cy={y(s.values[selected] as number)} r="4" fill={s.color} />
          ),
        )}

      <rect
        x={left}
        y={top}
        width={right - left}
        height={bottom - top + 20}
        fill="transparent"
        onMouseMove={onMove}
        onClick={onMove}
      />
    </svg>
  );
}
