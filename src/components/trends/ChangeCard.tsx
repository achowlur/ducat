"use client";

import { money, monthAbbrev, monthLabel, shortMonthLabel } from "../../lib/ui/format";
import { spanName, type CompareKey, type Comparison, type GroupBy, type Measure, type Span } from "../../lib/ui/report";
import { B_DEFAULTS, B_VIEWS, type BView } from "../../lib/ui/trendsParams";
import { CardFrame, Fig, Hero, Lead, Note } from "./CardFrame";
import { ChangeView, signedMoney } from "./ChangeView";
import { ReportSelect } from "./ReportSelect";
import { useCardView, ViewSwitch } from "./ViewSwitch";

const SPANS: { value: CompareKey; label: string }[] = [
  { value: "1m", label: "Last month vs the one before" },
  { value: "mtd", label: "This month vs the same days last month" },
  { value: "3m", label: "Last 3 months vs the 3 before" },
  { value: "12m", label: "Last 12 months vs the 12 before" },
  { value: "ytd", label: "This year vs the same months last year" },
];
const BYS: { value: GroupBy; label: string }[] = [
  { value: "category", label: "Category" },
  { value: "merchant", label: "Merchant" },
  { value: "account", label: "Card or account" },
];
const SHOWS: { value: Measure; label: string }[] = [
  { value: "spending", label: "Spending" },
  { value: "income", label: "Income" },
];
const NOUNS: Record<GroupBy, string> = { category: "categories", merchant: "merchants", account: "accounts" };

/** Column heads short enough for a phone; the headline names the months in full. */
function columnNames(span: CompareKey, c: Comparison): { current: string; prior: string } {
  const day = c.spans.throughDay;
  switch (span) {
    case "1m":
      return { current: monthAbbrev(c.spans.current.from), prior: monthAbbrev(c.spans.prior.from) };
    case "mtd":
      return {
        current: `${monthAbbrev(c.spans.current.from)} 1–${day}`,
        prior: `${monthAbbrev(c.spans.prior.from)} 1–${day}`,
      };
    case "3m":
      return { current: "Last 3", prior: "3 before" };
    case "12m":
      return { current: "Last 12", prior: "12 before" };
    case "ytd":
      return { current: c.spans.current.from.slice(0, 4), prior: c.spans.prior.from.slice(0, 4) };
  }
}

/** "September 2026", "Oct 1 to 3", "Oct 2025 to Sep 2026". */
function when(span: Span, throughDay: number | null): string {
  if (span.from !== span.to) return spanName(span);
  if (throughDay === null) return monthLabel(span.from);
  const mon = monthAbbrev(span.from);
  return throughDay === 1 ? `${mon} 1` : `${mon} 1 to ${throughDay}`;
}

export interface LateAccount {
  name: string;
  /** "2026-08-14": the day its records begin. */
  firstDay: string;
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * What changed between two spans, and where. Every row opens the rows behind
 * its current figure, and the rows add up to the change the headline states,
 * so no total row repeats it beneath them (the table, whose columns need
 * closing, keeps one).
 */
export function ChangeCard({
  comparison,
  span,
  by,
  show,
  initialView,
  firstMonth,
  lateAccounts,
}: {
  comparison: Comparison;
  span: CompareKey;
  by: GroupBy;
  show: Measure;
  initialView: BView;
  /** The first month on record, for the coverage note. */
  firstMonth: string | null;
  /** Accounts whose records begin inside the earlier span: it holds none of their earlier days. */
  lateAccounts: LateAccount[];
}) {
  const [view, setView] = useCardView<BView>("b", initialView);
  const names = columnNames(span, comparison);
  const { total, spans } = comparison;
  const verb = show === "spending" ? "spent" : "received";
  // More spending is the warning colour, more income the good one.
  const tone = total.change === 0 ? undefined : (total.change > 0) === (show === "spending") ? "neg" : "pos";
  const pct = total.prior > 0 && total.current >= 0 ? Math.round((total.change / total.prior) * 100) : null;
  const priorMonths = monthsBetween(spans.prior.from, spans.prior.to);

  return (
    <CardFrame
      id="what-changed"
      title="What changed"
      switcher={<ViewSwitch options={[...B_VIEWS]} value={view} onChange={setView} />}
      controls={
        <>
          <ReportSelect name="b.span" label="Compare" value={span} fallback={B_DEFAULTS.span} options={SPANS} />
          <ReportSelect name="b.by" label="By" value={by} fallback={B_DEFAULTS.by} options={BYS} />
          <ReportSelect name="b.show" label="Show" value={show} fallback={B_DEFAULTS.show} options={SHOWS} />
        </>
      }
    >
      <Hero figure={signedMoney(total.change)} tone={tone}>
        <Lead>{when(spans.current, spans.throughDay)}</Lead>: <Fig>{money(total.current)}</Fig> {verb}, against{" "}
        <Fig>{money(total.prior)}</Fig> {spans.prior.from === spans.prior.to ? "in" : "over"}{" "}
        {when(spans.prior, spans.throughDay)}
        {pct !== null && pct !== 0 && (
          <>
            {" "}
            · <Fig tone={tone}>{`${total.change > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`}</Fig>
          </>
        )}
        .
      </Hero>
      <ChangeView
        view={view}
        comparison={comparison}
        measure={show}
        currentName={names.current}
        priorName={names.prior}
        noun={NOUNS[by]}
      />
      {comparison.priorMonthsMissing > 0 && firstMonth !== null && (
        <Note>
          Records begin in {shortMonthLabel(firstMonth)}, so the earlier span holds{" "}
          {Math.max(0, priorMonths - comparison.priorMonthsMissing)} of its {priorMonths} months; its total is short
          by the rest.
        </Note>
      )}
      {lateAccounts.length > 0 && (
        <Note>
          {lateAccounts.map((a, i) => (
            <span key={a.name}>
              {i > 0 && "; "}
              {a.name} begins {dayLabel(a.firstDay)}
            </span>
          ))}
          . The earlier span holds none of {lateAccounts.length === 1 ? "its" : "their"} activity before that, so part
          of any rise is records starting rather than money spent.
        </Note>
      )}
    </CardFrame>
  );
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}
