import type { DonutSliceData } from "./spendingBreakdown";

/**
 * Overview's ring colours, shared by the arcs (a CSS variable) and the legend
 * swatches (a Tailwind class, which must be a literal string to be generated).
 * Seven hues cover the most named slices OVERVIEW_SLICING allows; Other is
 * always the neutral, so it never reads as one more category.
 */
const FILLS = ["var(--chart1)", "var(--chart2)", "var(--pie3)", "var(--pie4)", "var(--pie5)", "var(--pie6)", "var(--pie7)"];
const SWATCHES = ["bg-chart1", "bg-chart2", "bg-pie3", "bg-pie4", "bg-pie5", "bg-pie6", "bg-pie7"];

export function sliceFill(slice: Pick<DonutSliceData, "isOther">, index: number): string {
  return slice.isOther ? "var(--pie-other)" : FILLS[index % FILLS.length];
}

export function sliceSwatch(slice: Pick<DonutSliceData, "isOther">, index: number): string {
  return slice.isOther ? "bg-pie-other" : SWATCHES[index % SWATCHES.length];
}
