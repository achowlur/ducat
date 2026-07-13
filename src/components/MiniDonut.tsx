import type { DonutSlice } from "../lib/ui/overview";

const COLORS = ["var(--chart1)", "var(--chart2)", "var(--pie3)", "var(--pie4)"];

interface Point {
  x: number;
  y: number;
}

function polar(cx: number, cy: number, r: number, angleDeg: number): Point {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

/** Donut slice path: outer arc clockwise, inner arc back. Angles from 12 o'clock. */
function slicePath(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  const large = a1 - a0 > 180 ? 1 : 0;
  const o0 = polar(cx, cy, R, a0);
  const o1 = polar(cx, cy, R, a1);
  const i0 = polar(cx, cy, r, a0);
  const i1 = polar(cx, cy, r, a1);
  return [
    `M${o0.x.toFixed(2)},${o0.y.toFixed(2)}`,
    `A${R},${R} 0 ${large} 1 ${o1.x.toFixed(2)},${o1.y.toFixed(2)}`,
    `L${i1.x.toFixed(2)},${i1.y.toFixed(2)}`,
    `A${r},${r} 0 ${large} 0 ${i0.x.toFixed(2)},${i0.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

/**
 * Server-renderable donut (no hooks). Slices ordered largest-first from
 * 12 o'clock; 2px paper gaps between slices; total in the hole.
 */
export function MiniDonut({
  slices,
  centerTop,
  centerBottom,
  width = 170,
}: {
  slices: DonutSlice[];
  centerTop: string;
  centerBottom: string;
  width?: number;
}) {
  const cx = 110;
  const cy = 100;
  let angle = 0;
  const paths = slices.map((s, i) => {
    const sweep = s.share * 360;
    // Cap at 359.9° — a single full-circle arc renders as nothing in SVG.
    const a0 = angle;
    const a1 = Math.min(angle + sweep, 359.9);
    angle += sweep;
    return { d: slicePath(cx, cy, 70, 40, a0, a1), color: COLORS[i % COLORS.length], slice: s };
  });

  const label = slices
    .map((s) => `${s.label} ${(s.share * 100).toFixed(0)}%`)
    .join(", ");

  return (
    <svg viewBox="0 0 220 200" width={width} role="img" aria-label={`Spending by category: ${label}`}>
      <g stroke="var(--paper)" strokeWidth="2">
        {paths.map((p) => (
          <path key={p.slice.label} d={p.d} fill={p.color}>
            <title>{`${p.slice.label}: ${(p.slice.share * 100).toFixed(1)}%`}</title>
          </path>
        ))}
      </g>
      <text x={cx} y={cy - 4} textAnchor="middle" className="fill-[var(--ink)] font-money text-[11px]">
        {centerTop}
      </text>
      <text x={cx} y={cy + 10} textAnchor="middle" className="fill-[var(--faint)] font-money text-[9px]">
        {centerBottom}
      </text>
    </svg>
  );
}
