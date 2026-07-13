/**
 * Server-renderable balance sparkline: hairline history with an
 * emphasized endpoint, ledger style. Renders nothing for < 2 points.
 */
export function Sparkline({ values, width = 90, height = 22 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const x = (i: number) => pad + ((width - 2 * pad) * i) / (values.length - 1);
  const y = (v: number) => height - pad - ((height - 2 * pad) * (v - min)) / span;
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Balance history: ${values.length} snapshots`}
    >
      <polyline points={points} fill="none" stroke="var(--chart1)" strokeWidth="1.5" />
      <circle cx={x(values.length - 1)} cy={y(last)} r="2.5" fill="var(--chart1)" />
    </svg>
  );
}
