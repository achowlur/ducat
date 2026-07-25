import type { PeriodCoverage } from "../lib/insights/coverage";

/**
 * Warns that a period predates some accounts' history, so its totals are
 * understated. Without this the gap is invisible: the month an account's
 * history begins reads as a spending jump that never happened.
 */
export function CoverageNotice({ coverage }: { coverage: PeriodCoverage | null }) {
  if (coverage === null) return null;
  const { covered, total, missing } = coverage;
  const shown = missing.slice(0, 3).join(", ");
  const extra = missing.length > 3 ? ` +${missing.length - 3} more` : "";

  return (
    <p
      className="border-l-2 border-chart2 bg-chip/50 px-2.5 py-1.5 text-[0.75rem] text-faint"
      title={`No data before this period for: ${missing.join(", ")}`}
    >
      <span className="font-semibold text-acc">Partial coverage</span> — {covered} of {total} accounts have
      history this far back. Totals here exclude {shown}
      {extra}, so spending and cash flow are understated.
    </p>
  );
}
