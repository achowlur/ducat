import Link from "next/link";
import { sliceFill } from "../lib/ui/donutColors";
import type { DonutSliceData } from "../lib/ui/spendingBreakdown";

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
 *
 * `hrefFor` makes the slices navigable. Optional, because the donut is a
 * drawing and shouldn't require a destination to exist — but Overview passes
 * one, so a slice goes where the number it draws came from.
 */
export function MiniDonut({
  slices,
  centerTop,
  centerBottom,
  className = "w-[170px]",
  hrefFor,
}: {
  slices: DonutSliceData[];
  centerTop: string;
  centerBottom: string;
  /**
   * Sizing and alignment, as CSS rather than an SVG `width` attribute, because
   * the donut wants to be bigger on a phone than beside the legend on a desktop
   * and an attribute cannot carry a breakpoint. The viewBox scales it.
   */
  className?: string;
  hrefFor?: (slice: DonutSliceData) => string;
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
    return { d: slicePath(cx, cy, 70, 40, a0, a1), color: sliceFill(s, i), slice: s };
  });

  const label = slices
    .map((s) => `${s.label} ${(s.share * 100).toFixed(0)}%`)
    .join(", ");

  return (
    // Cropped to the ring (outer radius 70 plus the 2px stroke): the old 220×200
    // box spent over a third of its width on padding, so a 200px donut drew a
    // 127px ring. Nothing is drawn outside it — the hover tooltip lives on
    // /trends' donut, not this one.
    <svg viewBox="38 28 144 144" className={className} role="img" aria-label={`Spending by category: ${label}`}>
      <g stroke="var(--paper)" strokeWidth="2">
        {paths.map((p) => {
          // ONE string child, never two. React serializes <title> from `children`
          // only when it is a single string; an array of two makes the server emit
          // `<title></title>` while the client renders the text, and the resulting
          // hydration mismatch throws away the whole document — taking the
          // pre-paint data-theme with it, so Overview alone rendered sepia for
          // anyone who had chosen light or dark. Pinned by MiniDonut.test.ts.
          const tip = `${p.slice.label}: ${(p.slice.share * 100).toFixed(1)}%${
            hrefFor === undefined ? "" : " — view transactions"
          }`;
          const arc = (
            <path key={p.slice.label} d={p.d} fill={p.color} className={hrefFor === undefined ? "" : "cursor-pointer"}>
              <title>{tip}</title>
            </path>
          );
          if (hrefFor === undefined) return arc;
          return (
            <Link key={p.slice.label} href={hrefFor(p.slice)} aria-label={`${p.slice.label} transactions`}>
              {arc}
            </Link>
          );
        })}
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
