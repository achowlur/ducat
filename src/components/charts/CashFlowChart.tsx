"use client";

import { useState } from "react";
import { money } from "../../lib/ui/format";
import { axisMoney, niceTicks } from "./scale";

interface MonthFlow {
  period: string;
  label: string;
  income: number;
  spending: number;
  net: number;
}

const VIEW_W = 520;
const VIEW_H = 210;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 182;
const PLOT_LEFT = 8;
const PLOT_RIGHT = 468;
const BAR_W = 10;
const PAIR_GAP = 2;

/**
 * Paired income/spending columns per month. Hover a month for the full
 * numbers; the latest month's spending is direct-labeled, placed above
 * the whole pair so it can never collide with a bar.
 */
export function CashFlowChart({ months }: { months: MonthFlow[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  // Same guard as NetWorthChart: `slot` divides by months.length and
  // months[latest] indexes -1, so an empty series must never reach the math.
  if (months.length === 0) {
    return <p className="py-6 text-[0.85rem] text-faint">No months with income or spending yet.</p>;
  }

  const maxVal = Math.max(...months.map((m) => Math.max(m.income, m.spending)), 1);
  const ticks = niceTicks(0, maxVal * 1.06, 4);
  const top = ticks[ticks.length - 1];
  const y = (v: number) => PLOT_BOTTOM - (v / top) * (PLOT_BOTTOM - PLOT_TOP);

  const slot = (PLOT_RIGHT - PLOT_LEFT) / months.length;
  const pairX = (i: number) => PLOT_LEFT + slot * i + slot / 2 - BAR_W - PAIR_GAP / 2;

  const latest = months.length - 1;
  // The static label must never touch a mark: place it above EVERY bar's
  // top, and clamp x so the text stays inside the plot, clear of the axis
  // labels. A dashed leader ties it back to the spending bar it describes.
  const tallestTop = Math.min(...months.map((m) => y(Math.max(m.income, m.spending))));
  const latestLabelY = Math.max(tallestTop - 10, 10);
  const spendCenterX = pairX(latest) + BAR_W + PAIR_GAP + BAR_W / 2;
  const latestLabelX = Math.min(spendCenterX, PLOT_RIGHT - 38);

  const summary = months
    .map((m) => `${m.label}: income ${money(m.income)}, spending ${money(m.spending)}`)
    .join("; ");

  return (
    // Below md the chart keeps its natural 520px and the strip scrolls, rather
    // than scaling 26 months into 327px — that squeezed the axis type to 7px.
    // Two dozen months cannot be legible on a phone at any scale; scrolling a
    // timeline at least matches how one reads it.
    <div className="scroll-x md:overflow-visible">
      {/* The tooltip is positioned as a percentage of the plot, so it has to
          live inside the element that IS the plot's width — and it then
          scrolls with the bar it describes. */}
      <div className="relative w-[520px] md:w-full">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full"
        role="img"
        aria-label={`Monthly income and spending. ${summary}`}
      >
        {ticks.slice(1).map((t) => (
          <g key={t}>
            <line x1={PLOT_LEFT} y1={y(t)} x2={PLOT_RIGHT} y2={y(t)} stroke="var(--grid)" strokeWidth="1" />
            <text x={PLOT_RIGHT + 6} y={y(t) + 3} className="fill-[var(--faint)] font-money text-[10px]">
              {axisMoney(t)}
            </text>
          </g>
        ))}
        <line x1={PLOT_LEFT} y1={PLOT_BOTTOM} x2={PLOT_RIGHT} y2={PLOT_BOTTOM} stroke="var(--ink)" strokeWidth="1" />

        {months.map((m, i) => {
          const x = pairX(i);
          const dim = hovered !== null && hovered !== i;
          return (
            <g
              key={m.period}
              opacity={dim ? 0.45 : 1}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              // A tap toggles the same tooltip: touch has no hover, and these
              // figures exist nowhere else on the page.
              onClick={() => setHovered(hovered === i ? null : i)}
              className="transition-opacity"
            >
              {/* generous invisible hit target for the whole month */}
              <rect x={PLOT_LEFT + slot * i} y={PLOT_TOP} width={slot} height={PLOT_BOTTOM - PLOT_TOP} fill="transparent" />
              <rect x={x} y={y(m.income)} width={BAR_W} height={PLOT_BOTTOM - y(m.income)} rx="2" fill="var(--chart2)" />
              <rect
                x={x + BAR_W + PAIR_GAP}
                y={y(m.spending)}
                width={BAR_W}
                height={PLOT_BOTTOM - y(m.spending)}
                rx="2"
                fill="var(--chart1)"
              />
              <text x={PLOT_LEFT + slot * i + slot / 2} y={PLOT_BOTTOM + 14} textAnchor="middle" className="fill-[var(--faint)] font-money text-[10px]">
                {m.label}
              </text>
            </g>
          );
        })}

        {hovered === null && (
          <g>
            <text
              x={latestLabelX}
              y={latestLabelY}
              textAnchor="middle"
              className="fill-[var(--ink)] font-money text-[10.5px]"
            >
              {money(months[latest].spending)}
            </text>
            <line
              x1={spendCenterX}
              y1={latestLabelY + 4}
              x2={spendCenterX}
              y2={y(months[latest].spending) - 4}
              stroke="var(--faint)"
              strokeWidth="1"
              strokeDasharray="2,2"
            />
          </g>
        )}
      </svg>
      {hovered !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-[3px] bg-ink px-2.5 py-1.5 font-money text-[0.7rem] text-paper"
          style={{
            left: `${Math.min(Math.max(((PLOT_LEFT + slot * hovered + slot / 2) / VIEW_W) * 100, 6), 72)}%`,
            top: 0,
          }}
        >
          <div className="mb-0.5 text-[0.65rem] opacity-80">{months[hovered].label}</div>
          <div>income {money(months[hovered].income)}</div>
          <div>spending {money(months[hovered].spending)}</div>
          <div>net {money(months[hovered].net)}</div>
        </div>
      )}
      </div>
    </div>
  );
}
