import type { PeriodCoverage } from "../lib/insights/coverage";
import { money } from "../lib/ui/format";

/**
 * Says when a period's totals are not comparable with other periods, because
 * an account's history does not reach across all of it.
 *
 * Three things were wrong with the first version and all three misinformed.
 * It claimed "totals here exclude <account>", which was FALSE — that account's
 * transactions are in the totals; only its history is short. It reported a
 * COUNT of accounts rather than an amount, so a transit card holding $104.32 of
 * a $11,009.59 month got the same amber banner a missing mortgage would. And it
 * collapsed two different claims into one sentence: an account that started
 * mid-period is known to the penny and merely breaks comparability, while an
 * account with no data at all understates the total by an amount nobody can
 * know. Only the second earns amber.
 */
export function CoverageNotice({ coverage }: { coverage: PeriodCoverage | null }) {
  if (coverage === null || coverage.complete) return null;
  const { covered, total, gaps, contributedByPartial, hasUnknownShortfall } = coverage;

  const partial = gaps.filter((g) => g.kind === "STARTED_MID_PERIOD");
  const absent = gaps.filter((g) => g.kind === "NO_DATA");
  const list = (names: string[]) =>
    names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;

  return (
    <p
      className={`border-l-2 px-2.5 py-1.5 text-[0.75rem] text-faint ${
        hasUnknownShortfall ? "border-chart2 bg-chip/50" : "border-rule"
      }`}
      title={gaps
        .map(
          (g) =>
            `${g.name}: ${g.kind === "NO_DATA" ? "no data for this period" : `${money(g.contributed)} from a mid-period start`}`,
        )
        .join("\n")}
    >
      <span className={`font-semibold ${hasUnknownShortfall ? "text-acc" : ""}`}>
        {hasUnknownShortfall ? "Partial coverage" : "Not directly comparable"}
      </span>{" "}
      — {covered} of {total} accounts have history reaching across this period.
      {absent.length > 0 && (
        <>
          {" "}
          {list(absent.map((g) => g.name))} {absent.length === 1 ? "has" : "have"} none of it, so spending and
          cash flow are understated by an unknown amount.
        </>
      )}
      {partial.length > 0 && (
        <>
          {" "}
          {list(partial.map((g) => g.name))} started part-way through, contributing{" "}
          <span className="font-money tabular">{money(contributedByPartial)}</span> — counted in full here,
          but earlier months have none of it.
        </>
      )}
    </p>
  );
}
