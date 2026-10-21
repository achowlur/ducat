import { BudgetTable } from "../../components/BudgetTable";
import { withDatabaseNotice } from "../../components/DatabaseNotice";
import { MiniDonut } from "../../components/MiniDonut";
import { Fig } from "../../components/ui/figure";
import { PageTitle, SectionTitle } from "../../components/ui/headings";
import { dollars, MAX_MONTHLY_LINES, type Budget } from "../../lib/ui/budget";
import { getBudgetData } from "../../lib/ui/budgetPage";
import { sliceFill, sliceSwatch } from "../../lib/ui/donutColors";
import { monthLabel } from "../../lib/ui/format";
import { droppedNote, windowSpan } from "../../lib/ui/recentMonthsNote";
import type { DonutSliceData } from "../../lib/ui/spendingBreakdown";

export const dynamic = "force-dynamic";

/** Named slices the ring draws before the rest fold into Other, as Overview's ring. */
const RING_SLICES = 7;

/**
 * The budget: what is left to spend this month, each category against its
 * limit at the pace it usually spends, and yearly funds for spending that
 * comes in bulk. Limits are suggested from the category's own recent months
 * and change only where the operator types one (lib/ui/budget.ts). Figures
 * in view, the working-out behind one tap.
 */
export default async function BudgetPage() {
  return withDatabaseNotice(renderBudget);
}

async function renderBudget() {
  const b = await getBudgetData();
  const empty = b.monthly.length === 0 && b.yearly.length === 0;
  const dropped = droppedNote(b.window);

  return (
    <div className="grid max-w-[720px] gap-10 py-5">
      <PageTitle>Budget</PageTitle>

      <section>
        <SectionTitle>{monthLabel(b.period)}</SectionTitle>
        {empty ? <p className="text-[0.85rem] text-faint">Nothing recorded yet.</p> : <ThisMonth b={b} />}
      </section>

      {b.yearly.length > 0 && (
        <section>
          <SectionTitle>Yearly funds</SectionTitle>
          <BudgetTable lines={b.yearly} />
        </section>
      )}

      {!empty && (
        <details className="group text-[0.78rem] text-faint">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 max-md:min-h-[44px] [&::-webkit-details-marker]:hidden">
            How this works
            <span aria-hidden="true" className="text-[0.7rem] transition-transform group-open:rotate-90">
              ›
            </span>
          </summary>
          <ul className="grid gap-1.5 pt-1.5 leading-relaxed">
            {b.income !== null && b.toSave !== null && (
              <li>
                A typical month brings in <Fig>{dollars(b.income)}</Fig>. Limits plus yearly funds (
                <Fig>{dollars(b.yearlySetAside)}</Fig> a month) leave <Fig>{dollars(b.toSave)}</Fig> a month to save.
              </li>
            )}
            <li>
              Limits start at the middle of {windowSpan(b.window)} (yearly funds: the last{" "}
              {b.yearlyWindow.used.length} months). Tap a category to set your own.
            </li>
            <li>
              The {MAX_MONTHLY_LINES} largest limits are named; the rest add up under Other, a category new this month
              among them.
            </li>
            <li>The tick on a bar is where that category usually is by today.</li>
            <li>Yearly funds count from January 1, so one big month fits the year.</li>
            {dropped !== null && <li>{dropped}</li>}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * Overview's ring and ledger. The ring is the month's limits: each
 * category's spending a slice in Overview's colours, what is left drawn as
 * empty, the figures beside it as ledger lines; the table under it is the
 * ring's legend, totalled at the foot.
 */
function ThisMonth({ b }: { b: Budget }) {
  const spentLines = b.monthly.filter((l) => l.spent > 0).sort((x, y) => y.spent - x.spent);
  const named = spentLines.slice(0, RING_SLICES);
  const rest = spentLines.slice(RING_SLICES);
  const whole = Math.max(b.monthlyLimit, b.monthlySpent);
  const slice = (label: string, ids: string[], value: number, isOther: boolean): DonutSliceData => ({
    label,
    categoryIds: ids,
    value,
    share: whole > 0 ? value / whole : 0,
    isOther,
  });
  const unspent = slice("Left", [], b.left, true);
  const slices = [
    ...named.map((l) => slice(l.name, [l.key], l.spent, false)),
    ...(rest.length > 0 ? [slice("Other", rest.map((l) => l.key), rest.reduce((s, l) => s + l.spent, 0), true)] : []),
    ...(b.left > 0 ? [unspent] : []),
  ];
  const swatches: Record<string, string> = {};
  named.forEach((l, i) => (swatches[l.key] = sliceSwatch(slices[i], i)));
  rest.forEach((l) => (swatches[l.key] = "bg-pie-other"));
  for (const l of b.monthly) swatches[l.key] ??= "bg-rule";
  const figures = [
    { label: "Budgeted", value: dollars(b.monthlyLimit) },
    { label: "Spent", value: dollars(b.monthlySpent) },
    ...(b.perDay !== null
      ? [{ label: `A day for ${b.daysLeft} ${b.daysLeft === 1 ? "day" : "days"}`, value: dollars(b.perDay) }]
      : []),
  ];

  return (
    <>
      <div className="mb-5 flex items-center gap-5 sm:gap-8">
        <MiniDonut
          slices={slices}
          centerTop={b.left < 0 ? `${dollars(-b.left)} over` : dollars(b.left)}
          centerBottom={b.left < 0 ? "this month" : "left"}
          className="w-[150px] shrink-0 sm:w-[200px]"
          fillFor={(s, i) => (s === unspent ? "var(--rule)" : sliceFill(s, i))}
        />
        {/* Ledger lines, their amounts on the table's right edge below. */}
        <dl className="grid min-w-0 flex-1 self-center">
          {figures.map((f) => (
            <div key={f.label} className="flex items-baseline justify-between gap-3 border-b border-rule py-2 last:border-b-0">
              <dt className="text-[0.8rem] text-faint">{f.label}</dt>
              <dd className="font-money text-[1rem] tabular sm:text-[1.15rem]">{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {b.toSave !== null && b.toSave < 0 && (
        <p className="mb-4 text-[0.78rem] text-warn-ink">
          These limits spend <span className="font-money tabular">{dollars(-b.toSave)}</span> a month more than you earn.
        </p>
      )}
      {b.monthly.length > 0 && <BudgetTable lines={b.monthly} swatches={swatches} />}
    </>
  );
}
