"use client";

import { useEffect, useRef, useState } from "react";
import { money } from "../../lib/ui/format";
import { axisMoney, labelStepFor, monthWithYear, niceTicks } from "./scale";

interface MonthFlow {
  period: string;
  label: string;
  income: number;
  spending: number;
  net: number;
}

const VIEW_W = 520;
const VIEW_H = 226;
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

  // The strip is 520px inside 327px at 375px and opened at scrollLeft 0 — the
  // OLDEST end. Everything the reader needs first was off the right edge:
  // every y-axis label, the year caption, all four current-year months, and
  // the direct-label callout for the latest month, which the code goes to
  // trouble to place collision-free. What showed instead was mid-2024, with no
  // dollar scale anywhere and no scrollbar (`.scroll-x` hides it) to say more
  // existed. A finance timeline is read backwards from today, so open at today.
  //
  // Above the empty-series guard because hooks cannot sit behind a return.
  const strip = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = strip.current;
    if (box === null) return;
    box.scrollLeft = box.scrollWidth - box.clientWidth;
  }, [months.length]);

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

  /**
   * Two dozen months do not fit two dozen labels. At 26 months the plot gives
   * each one about 17px and "Jun" needs 26, so every label was printed and they
   * ran together into "JunJulAugSep…" — and with no year marker the three
   * different Junes were indistinguishable. Thin the labels to what fits, and
   * step from the END so the newest month is always one of them.
   */
  const labelStep = labelStepFor(slot, 26);
  const labelled = (i: number) => (latest - i) % labelStep === 0;

  // Where each year begins, for the divider and the year caption. The first
  // month is a year start too, so the earliest span is captioned as well.
  const yearOf = (i: number) => months[i].period.slice(0, 4);
  const yearStarts = months
    .map((_, i) => i)
    .filter((i) => i === 0 || yearOf(i) !== yearOf(i - 1));
  const yearSpans = yearStarts.map((start, n) => ({
    year: yearOf(start),
    start,
    end: n + 1 < yearStarts.length ? yearStarts[n + 1] - 1 : latest,
  }));
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
    <div ref={strip} className="scroll-x md:overflow-visible">
      {/* The tooltip is positioned as a percentage of the plot, so it has to
          live inside the element that IS the plot's width — and it then
          scrolls with the bar it describes. */}
      {/* Capped once the section went full-width. The SVG scales its whole
          viewBox with the container, so width buys legibility and then keeps
          going: at 1104px the scale factor is 2.12 and the 10px axis type
          renders at 25px — larger than the page's body text — in a chart 480px
          tall. 880px is the size this chart was measured to be legible at
          (~17px type, ~34px per month against the 18.2px it had at 534px),
          which is the whole point of the finding, without the type outgrowing
          the prose around it. */}
      <div className="relative w-[520px] md:w-full md:max-w-[880px]">
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

        {/* Year band. Without it "Jun" appears three times on this axis with
            nothing to say which Jun, which makes every month label a guess. */}
        {yearSpans.map((s) => (
          <g key={s.year}>
            {s.start > 0 && (
              <line
                x1={PLOT_LEFT + slot * s.start}
                y1={PLOT_TOP}
                x2={PLOT_LEFT + slot * s.start}
                y2={PLOT_BOTTOM + 17}
                stroke="var(--rule)"
                strokeWidth="1"
              />
            )}
            <text
              x={PLOT_LEFT + slot * s.start + (slot * (s.end - s.start + 1)) / 2}
              y={PLOT_BOTTOM + 27}
              textAnchor="middle"
              className="fill-[var(--faint)] font-money text-[10px] font-semibold"
            >
              {s.year}
            </text>
          </g>
        ))}

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
              {/* Clamped at 0. A month whose reimbursements outran its
                  spending gives a NEGATIVE height, which is invalid SVG — the
                  element simply does not render, so four months drew a tall
                  income bar beside nothing and read as "spent nothing" rather
                  than "was net refunded". The stub below the axis is what
                  distinguishes the two. */}
              <rect
                x={x}
                y={y(m.income)}
                width={BAR_W}
                height={Math.max(0, PLOT_BOTTOM - y(m.income))}
                rx="2"
                fill="var(--chart2)"
              />
              <rect
                x={x + BAR_W + PAIR_GAP}
                y={m.spending < 0 ? PLOT_BOTTOM : y(m.spending)}
                width={BAR_W}
                height={m.spending < 0 ? 3 : Math.max(0, PLOT_BOTTOM - y(m.spending))}
                rx="2"
                fill="var(--chart1)"
              />
              {labelled(i) && (
                <text
                  x={PLOT_LEFT + slot * i + slot / 2}
                  y={PLOT_BOTTOM + 13}
                  textAnchor="middle"
                  className="fill-[var(--faint)] font-money text-[10px]"
                >
                  {m.label}
                </text>
              )}
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
          <div className="mb-0.5 text-[0.65rem] opacity-80">{monthWithYear(months[hovered].period)}</div>
          <div>income {money(months[hovered].income)}</div>
          <div>spending {money(months[hovered].spending)}</div>
          <div>net {money(months[hovered].net)}</div>
        </div>
      )}
      </div>
    </div>
  );
}
