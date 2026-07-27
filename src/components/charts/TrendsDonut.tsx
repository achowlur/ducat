"use client";

import Link from "next/link";
import { useState } from "react";
import type { DonutSliceData } from "../../lib/ui/trends";
import { money } from "../../lib/ui/format";
import { transactionsHref } from "../../lib/ui/categoryFilter";

const COLORS = ["var(--chart1)", "var(--chart2)", "var(--pie3)", "var(--pie4)"];

function polar(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function slicePath(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  const large = a1 - a0 > 180 ? 1 : 0;
  const o0 = polar(cx, cy, R, a0);
  const o1 = polar(cx, cy, R, a1);
  const i0 = polar(cx, cy, r, a0);
  const i1 = polar(cx, cy, r, a1);
  return `M${o0.x.toFixed(2)},${o0.y.toFixed(2)} A${R},${R} 0 ${large} 1 ${o1.x.toFixed(2)},${o1.y.toFixed(2)} L${i1.x.toFixed(2)},${i1.y.toFixed(2)} A${r},${r} 0 ${large} 0 ${i0.x.toFixed(2)},${i0.y.toFixed(2)} Z`;
}

/**
 * Interactive spending donut: hover raises a tooltip and dims the other
 * slices; click drills into Transactions pre-filtered to the period and to
 * every category the slice stands for — which for "Other" is the whole set
 * ranked below the top slices, enumerated for THIS month.
 *
 * It used to build the link from a single `categoryId` and omit the filter
 * when that was null, which was wrong for two different slices: "Other" and
 * "Uncategorized" both carry null, so clicking either drilled into the entire
 * ledger instead of the ~$2006 or the uncategorized pile it had just drawn.
 */
export function TrendsDonut({
  slices,
  total,
  period,
}: {
  slices: DonutSliceData[];
  total: number;
  period: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const cx = 110;
  const cy = 100;
  let angle = 0;
  const paths = slices.map((s, i) => {
    const a0 = angle;
    const a1 = Math.min(angle + s.share * 360, 359.9);
    angle += s.share * 360;
    const mid = polar(cx, cy, 55, (a0 + a1) / 2);
    return { d: slicePath(cx, cy, 70, 40, a0, a1), color: COLORS[i % COLORS.length], mid, slice: s, i };
  });

  const active = hovered === null ? null : paths[hovered];

  return (
    <div className="relative" style={{ width: 230 }}>
      <svg viewBox="0 0 220 200" width="230" role="img" aria-label="Spending by category donut">
        <g stroke="var(--paper)" strokeWidth="2">
          {paths.map((p) => (
            <Link key={p.slice.label} href={transactionsHref(p.slice.categoryIds, period)}>
              <path
                d={p.d}
                fill={p.color}
                opacity={hovered === null || hovered === p.i ? 1 : 0.45}
                onMouseEnter={() => setHovered(p.i)}
                onMouseLeave={() => setHovered(null)}
                className="cursor-pointer transition-opacity"
              />
            </Link>
          ))}
        </g>
        <text x={cx} y={cy - 4} textAnchor="middle" className="pointer-events-none fill-[var(--ink)] font-money text-[11px]">
          {money(total)}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" className="pointer-events-none fill-[var(--faint)] font-money text-[9px]">
          total
        </text>
      </svg>
      {active !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-[3px] bg-ink px-2.5 py-1.5 font-money text-[0.7rem] text-paper"
          style={{
            left: `${Math.min(Math.max((active.mid.x / 220) * 100, 8), 60)}%`,
            top: `${(active.mid.y / 200) * 100}%`,
          }}
        >
          <div>
            {active.slice.label} · {(active.slice.share * 100).toFixed(1)}%
          </div>
          <div>
            {money(active.slice.value)} ↗ view
            {active.slice.categoryIds.length > 1 && ` ${active.slice.categoryIds.length} categories`}
          </div>
        </div>
      )}
    </div>
  );
}
