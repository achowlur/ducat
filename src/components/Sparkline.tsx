/**
 * Server-renderable balance sparkline: hairline history with an
 * emphasized endpoint, ledger style. Renders nothing for < 2 points.
 */
export function Sparkline({
  values,
  width = 90,
  height = 22,
  totalCount,
}: {
  values: number[];
  width?: number;
  height?: number;
  /** How many snapshots EXIST, when more than are drawn. */
  totalCount?: number;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = max === min;
  const span = flat ? 1 : max - min;
  const pad = 3;
  const x = (i: number) => pad + ((width - 2 * pad) * i) / (values.length - 1);
  // A balance that never moved normalises every point to 0 and drew a line
  // along the FLOOR, which reads as "at its low" beside a neighbour climbing
  // to the top. Unchanged is not lowest; it belongs at mid-height.
  const y = (v: number) =>
    flat ? height / 2 : height - pad - ((height - 2 * pad) * (v - min)) / span;
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      // Says what it DRAWS. The row beside it prints the full count, and the
      // series is capped at the last 12, so this announced "12 snapshots" next
      // to a visible "34 snapshots" on the same row.
      aria-label={
        totalCount === undefined || totalCount === values.length
          ? `Balance history: ${values.length} snapshots`
          : `Balance history: last ${values.length} of ${totalCount} snapshots`
      }
    >
      <polyline points={points} fill="none" stroke="var(--chart1)" strokeWidth="1.5" />
      <circle cx={x(values.length - 1)} cy={y(last)} r="2.5" fill="var(--chart1)" />
    </svg>
  );
}
