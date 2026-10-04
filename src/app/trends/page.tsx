import { cookies } from "next/headers";
import { NetWorthChart } from "../../components/charts/NetWorthChart";
import { withDatabaseNotice } from "../../components/DatabaseNotice";
import { ChangeCard, type LateAccount } from "../../components/trends/ChangeCard";
import { ExploreCard, type ExploreData } from "../../components/trends/ExploreCard";
import { MonthSoFarCard } from "../../components/trends/MonthSoFarCard";
import type { SelectOption } from "../../components/trends/ReportSelect";
import { PageTitle, SectionTitle } from "../../components/ui/headings";
import { periodKey } from "../../lib/insights/periods";
import { P2P_UNREVIEWED_ID, P2P_UNREVIEWED_NAME } from "../../lib/p2p";
import {
  compare,
  compareSpans,
  exploreSpan,
  firstMonth,
  groupedSeries,
  monthSeries,
  monthSoFar,
  UNCATEGORIZED_KEY,
  type Entry,
  type GroupTarget,
  type Measure,
  type Span,
} from "../../lib/ui/report";
import { getTrendsSource, type TrendsSource } from "../../lib/ui/trends";
import { parseTrendsParams, targetParam, type RawSearch } from "../../lib/ui/trendsParams";

export const dynamic = "force-dynamic";

export default async function TrendsPage(props: { searchParams: Promise<RawSearch> }) {
  return withDatabaseNotice(() => renderTrends(props));
}

/**
 * Accounts whose records begin after the earlier span STARTS and that hold
 * some of `measure` in the current span: the earlier span is missing part of
 * them, so a rise is partly records starting. Counted by DAY, because an
 * account covers a period only if its first transaction is at or before the
 * period's start, and a card that began on the 14th misses half of a
 * one-month comparison. An account with nothing in the current span changes
 * nothing either way and is not named.
 */
function lateAccounts(source: TrendsSource, measure: Measure, prior: Span, current: Span): LateAccount[] {
  const active = new Set(
    source.entries
      .filter((e) => e.measure === measure && e.month >= current.from && e.month <= current.to)
      .map((e) => e.accountId),
  );
  const start = `${prior.from}-01`;
  return source.accounts.flatMap((a) =>
    a.firstDay !== null && a.firstDay > start && a.firstDay.slice(0, 7) <= current.to && active.has(a.id)
      ? [{ name: a.name, firstDay: a.firstDay }]
      : [],
  );
}

/** A filter naming something that exists, with its label; anything else is no filter. */
function resolveTarget(
  target: GroupTarget | null,
  source: TrendsSource,
  entries: Entry[],
): { target: GroupTarget; label: string } | null {
  if (target === null) return null;
  if (target.by === "category") {
    if (target.key === UNCATEGORIZED_KEY) return { target, label: "Uncategorized" };
    if (target.key === P2P_UNREVIEWED_ID) return { target, label: P2P_UNREVIEWED_NAME };
    const c = source.categories.find((x) => x.id === target.key);
    return c === undefined ? null : { target, label: c.name };
  }
  if (target.by === "account") {
    const a = source.accounts.find((x) => x.id === target.key);
    return a === undefined ? null : { target, label: a.name };
  }
  const named = entries.find((e) => e.merchant === target.key);
  return named === undefined ? null : { target, label: named.merchantName };
}

async function renderTrends({ searchParams }: { searchParams: Promise<RawSearch> }) {
  const [raw, jar, source] = await Promise.all([searchParams, cookies(), getTrendsSource()]);
  const params = parseTrendsParams(raw, (name) => jar.get(name)?.value);
  // ONE `now` for every card, or a render straddling midnight UTC could put
  // two cards in different months.
  const now = new Date();
  const { entries } = source;

  if (entries.length === 0) {
    return (
      <div className="py-5">
        <PageTitle>Trends</PageTitle>
        <p className="py-10 text-faint">
          Nothing to chart yet: no income or spending is on record. Run a sync or import a CSV, and this page fills
          in.
        </p>
      </div>
    );
  }

  const first = firstMonth(entries);

  const spans = compareSpans(params.b.span, now);
  const comparison = compare(entries, params.b.show, params.b.by, spans, source.accountNames);

  const filter = resolveTarget(params.e.for, source, entries);
  const span = exploreSpan(params.e.over, now, first);
  const explore: ExploreData =
    span === null
      ? { kind: "empty" }
      : params.e.by === "month"
        ? {
            kind: "months",
            series: monthSeries(
              entries,
              params.e.show === "both" ? ["income", "spending"] : [params.e.show],
              span,
              filter?.target ?? null,
            ),
          }
        : {
            kind: "groups",
            grouped: groupedSeries(
              entries,
              params.e.show === "both" ? "spending" : params.e.show,
              params.e.by,
              span,
              filter?.target ?? null,
              source.accountNames,
            ),
          };
  // Only categories the measure can hold: an income category asked for its
  // spending can only draw an empty card. The one already chosen stays listed
  // whatever it is, or the select would claim a different filter.
  const chosen = filter === null ? null : targetParam(filter.target);
  const fits = (c: { isIncome: boolean }) =>
    params.e.show === "both" || c.isIncome === (params.e.show === "income");
  const forOptions: SelectOption[] = [
    { value: "", label: "Everything" },
    ...source.categories
      .filter((c) => fits(c) || `category:${c.id}` === chosen)
      .map((c) => ({ value: `category:${c.id}`, label: c.name, group: "Category" })),
    { value: `category:${UNCATEGORIZED_KEY}`, label: "Uncategorized", group: "Category" },
    { value: `category:${P2P_UNREVIEWED_ID}`, label: P2P_UNREVIEWED_NAME, group: "Category" },
    ...source.accounts.map((a) => ({ value: `account:${a.id}`, label: a.name, group: "Card or account" })),
    ...(filter !== null && filter.target.by === "merchant"
      ? [{ value: targetParam(filter.target), label: filter.label, group: "Merchant" }]
      : []),
  ];

  const estimatedMonths = source.netWorth.filter((m) => m.estimated).length;

  return (
    <div className="grid gap-10 py-5">
      <PageTitle>Trends</PageTitle>
      <MonthSoFarCard data={monthSoFar(entries, now)} initialView={params.a.view} />
      <ChangeCard
        comparison={comparison}
        span={params.b.span}
        by={params.b.by}
        show={params.b.show}
        initialView={params.b.view}
        firstMonth={first}
        lateAccounts={lateAccounts(source, params.b.show, spans.prior, spans.current)}
      />
      <ExploreCard
        data={explore}
        show={params.e.show}
        by={params.e.by}
        forValue={filter === null ? "" : targetParam(filter.target)}
        forLabel={filter?.label ?? null}
        forOptions={forOptions}
        over={params.e.over}
        currentMonth={periodKey(now, "MONTH")}
        initialView={params.e.view}
      />

      <section className="min-w-0">
        <SectionTitle>Net worth</SectionTitle>
        <p className="mb-3 text-[0.75rem] text-faint">
          Month-end, all accounts
          {source.netWorth.length > 0 && (
            <>
              ,{" "}
              <span className="text-ink">{source.netWorth[0].label}</span> to{" "}
              <span className="text-ink">{source.netWorth[source.netWorth.length - 1].label}</span>
            </>
          )}
          . Hover or tap a month for exact figures; months drawn with a dashed line and a hollow point lack a balance
          snapshot for at least one account.
          {/* How MANY are estimated is a fact about the whole line, not a
              per-point footnote: six of seven is a reason to discount the
              slope, and it was reachable only by hovering each month in turn. */}
          {estimatedMonths > 0 && (
            <>
              {" "}
              <span className="text-ink">
                {estimatedMonths} of {source.netWorth.length} month
                {source.netWorth.length === 1 ? "" : "s"} {estimatedMonths === 1 ? "is" : "are"} partly estimated
              </span>
              .
            </>
          )}
          {/* The cards above span what the ledger holds; net worth REFUSES a
              month it cannot fully know, so its line is a record of when
              snapshots begin, not of when the money did. */}
          {source.netWorth.length > 0 && first !== null && source.netWorth[0].period > first && (
            <>
              {" "}
              Shorter than the spending history above because a month appears only once every account has a balance
              snapshot inside it; earlier months are refused rather than estimated.
            </>
          )}
        </p>
        {source.netWorth.length < 3 && (
          <p className="mb-3 border-l-2 border-warn bg-chip/50 px-2.5 py-1.5 text-[0.75rem] text-faint">
            <span className="font-semibold text-acc">History starts here.</span> Net worth is only shown for months with
            a balance snapshot behind every account. Imported transactions can&apos;t supply one: a brokerage&apos;s value
            moves with the market, which leaves no transaction to reconstruct from, so earlier months would be guesses
            rather than history. Each sync records a snapshot, so this line grows from today forward.
          </p>
        )}
        <NetWorthChart months={source.netWorth} />
      </section>
    </div>
  );
}
