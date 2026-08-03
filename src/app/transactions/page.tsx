import Link from "next/link";
import type { Prisma } from "../../generated/prisma/client";
import { CategoryButton, CategoryPickerProvider } from "../../components/CategoryPicker";
import { GroupChip, GroupPickerProvider, GroupTrigger } from "../../components/GroupPicker";
import { RenameGroup } from "../../components/RenameGroup";
import { GroupedReview, type PayeeGroupView } from "../../components/GroupedReview";
import { ReimburseControl } from "../../components/ReimburseControl";
import { draftSubscription } from "../../lib/health/registerSubscription";
import { prisma } from "../../lib/prisma";
import { periodEndExclusive, periodStart } from "../../lib/insights/periods";
import {
  makeCandidateFinder,
  NON_REIMBURSABLE_ACCOUNT_TYPES,
  REIMBURSE_LEAD_DAYS,
  REIMBURSE_POOL_TAKE,
  REIMBURSE_WINDOW_DAYS,
} from "../../lib/ui/reimburseCandidates";
import { groupByPayee } from "../../lib/sync/grouping";
import { P2P_PATTERN } from "../../lib/sync/rulePack";
import { amount, isoDate, money, monthLabel, titleCase } from "../../lib/ui/format";
import { periodKey } from "../../lib/insights/periods";
import { parseCategoryParam } from "../../lib/ui/categoryFilter";
import { parseGroupParam } from "../../lib/ui/groupFilter";
import { merchantLabel } from "../../lib/ui/merchantLabel";

export const dynamic = "force-dynamic";
// This page's actions are the slowest in the app: categorizing a group calls
// reapplyRules over every transaction, and four of them regenerate insights
// outright. Cheap against a local file, but in cloud mode each is an HTTP round
// trip to Turso — and bulk review on a phone is exactly when it happens.
export const maxDuration = 60;

const PAGE_SIZE = 100;

interface Params {
  period?: string;
  category?: string; // category id | "uncategorized"
  account?: string;
  flow?: string;
  q?: string;
  review?: string;
  page?: string;
  /** Trip/project label filter — owned by ui/groupFilter.ts. */
  group?: string;
  /** "1" = the group-by-payee bulk review queue (was `group` before trips claimed that name). */
  payees?: string;
}

function buildHref(params: Params, overrides: Partial<Params>): string {
  const merged = { ...params, ...overrides };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const qs = search.toString();
  return qs === "" ? "/transactions" : `/transactions?${qs}`;
}

const FLOW_BADGE: Record<string, string> = {
  INFLOW: "text-pos",
  OUTFLOW: "text-faint",
  TRANSFER: "text-acc",
};

/**
 * Six columns need 790px; a phone has 327px. Account and Flow drop below md
 * and reappear under the merchant, leaving date / merchant / category /
 * amount as the spine — the category control is the reason to open this
 * screen on a phone at all, so it stays.
 *
 * That spine did not fit either: four columns still needed 438px in a 327px
 * scroller, putting the whole AMOUNT column 111px past the visible edge, and
 * `.scroll-x` hides the scrollbar while the page body itself does not scroll,
 * so nothing said the table did. AMOUNT therefore joins the sub-line under the
 * merchant rather than holding a column of its own below md — the number is
 * why the screen exists, so it is the one thing that cannot be a swipe away.
 *
 * What is still off the edge, deliberately, is the TAIL of the category cell:
 * 374px against 327px, so the `rule` menu opener sits partly past it. Ranked
 * rather than eliminated — at 375px every remaining lever costs something
 * worse. Wrapping that cell fixed the width and took the median row from 57px
 * to 107px, i.e. a 100-row page from 6,213px to over 10,000px of scrolling, to
 * save 33px of a control that is already the SECONDARY way into a menu.
 * Hiding `rule` below md would have been cheaper still and is the worst of the
 * three: it is the only route to trip tagging and to categorizing a merchant
 * in bulk, and bulk review on a phone is exactly when those are wanted.
 * Measured at 375px: amount visible on 100 of 100 rows, category trigger
 * visible on 100 of 100, page body itself never scrolls sideways.
 */
const COLUMNS = [
  { label: "Date", className: "text-left" },
  { label: "Merchant / description", className: "text-left" },
  { label: "Account", className: "hidden text-left md:table-cell" },
  { label: "Category", className: "text-left" },
  { label: "Flow", className: "hidden text-left md:table-cell" },
  { label: "Amount", className: "hidden text-right md:table-cell" },
];

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;

  const page = Math.max(1, Math.floor(Number(params.page ?? "1")) || 1);

  const where: Prisma.TransactionWhereInput = {};
  if (params.period !== undefined && params.period !== "") {
    try {
      where.date = { gte: periodStart(params.period), lt: periodEndExclusive(params.period) };
    } catch {
      // Unparseable period param — ignore the filter rather than crash.
    }
  }
  // One id, `uncategorized`, or a comma-separated list of either — the donut's
  // "Other" slice is a SET of categories, so it arrives here enumerated.
  const selection = parseCategoryParam(params.category);
  if (selection !== null) {
    if (!selection.uncategorized) {
      where.categoryId = { in: selection.ids };
    } else if (selection.ids.length === 0) {
      where.categoryId = null;
    } else {
      // Mixed. Goes in AND rather than OR because `q` already owns top-level
      // OR, and the two would silently overwrite each other.
      where.AND = [{ OR: [{ categoryId: { in: selection.ids } }, { categoryId: null }] }];
    }
    // Transfers legitimately carry no category — they'd drown the queue, and
    // the donut this links from excludes them anyway. An explicit
    // flow=TRANSFER filter still shows them.
    if (selection.uncategorized && (params.flow === undefined || params.flow === "")) {
      where.flow = { not: "TRANSFER" };
    }
  }
  if (params.account !== undefined && params.account !== "") where.accountId = params.account;
  if (params.flow !== undefined && ["INFLOW", "OUTFLOW", "TRANSFER"].includes(params.flow)) {
    where.flow = params.flow as "INFLOW" | "OUTFLOW" | "TRANSFER";
  }
  if (params.q !== undefined && params.q.trim() !== "") {
    where.OR = [
      { description: { contains: params.q.trim() } },
      { normalizedMerchant: { contains: params.q.trim().toLowerCase() } },
    ];
  }
  // The trip/project filter: ONE label, read only through ui/groupFilter.ts.
  // A plain column equality, so it composes with everything above without
  // touching `q`'s top-level OR or the category group living in AND.
  const tripLabel = parseGroupParam(params.group);
  if (tripLabel !== null) where.groupLabel = tripLabel;

  // Review mode narrows in SQL as far as Prisma can, then finishes in JS: the
  // P2P test is a regex across two columns, which Prisma cannot express. Its
  // candidate set is small by construction, so it is fetched WHOLE and paged in
  // JS — paging in SQL and filtering afterwards gives uneven pages.
  const reviewMode = params.review === "1";
  const listWhere: Prisma.TransactionWhereInput = reviewMode
    ? { ...where, categoryId: null, reimbursesId: null, flow: { not: "TRANSFER" } }
    : where;

  const [rows, total, categories, accounts, dateRange, reviewPool, trackedSubs, groupLabelRows, tripTotals, tripTransfers, tripGroupTotal] = await Promise.all([
    prisma.transaction.findMany({
      where: listWhere,
      // A relation `include` is a ROUND TRIP, and this query had three of them
      // for a page that reads one string from two. `category` became dead the
      // moment the category picker started taking `categoryId` instead of the
      // object, and `account` supplies a NAME that `accounts` below already
      // has. Only `reimburses` genuinely needs the database — it points at
      // another transaction, so nothing in memory can answer it — and it is
      // narrowed to the three fields the chip renders.
      select: {
        id: true,
        date: true,
        amount: true,
        flow: true,
        description: true,
        normalizedMerchant: true,
        accountId: true,
        categoryId: true,
        categorySource: true,
        groupLabel: true,
        reimbursesId: true,
        reimburses: { select: { normalizedMerchant: true, description: true, date: true } },
      },
      orderBy: { date: "desc" },
      // Paged in SQL for the ledger; review mode pages in JS after filtering.
      ...(reviewMode ? {} : { skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    }),
    prisma.transaction.count({ where: listWhere }),
    prisma.category.findMany({ orderBy: { name: "asc" } }),
    prisma.account.findMany({ orderBy: { name: "asc" } }),
    prisma.transaction.aggregate({ _min: { date: true }, _max: { date: true } }),
    // The "N need review" nudge used to count within whatever rows the page
    // happened to fetch, so it undercounted — and with paging it would have got
    // worse. Three small columns over a set that shrinks to nothing as the
    // backlog clears, and it runs in parallel, so the count costs no latency.
    prisma.transaction.findMany({
      where: { ...where, categoryId: null, reimbursesId: null, flow: { not: "TRANSFER" } },
      select: { id: true, normalizedMerchant: true, description: true },
    }),
    // Which merchants are already tracked, so the row can show it rather than
    // let you register the same one twice. A tiny table, and it joins the group
    // rather than gating it.
    prisma.trackedSubscription.findMany({ select: { merchantPattern: true } }),
    // Every known trip label, for the ONE picker — the list crosses the wire
    // once, exactly as the category list does.
    prisma.transaction.findMany({
      where: { groupLabel: { not: null } },
      distinct: ["groupLabel"],
      select: { groupLabel: true },
      orderBy: { groupLabel: "asc" },
    }),
    // The totals band's facts, over the SAME `where` the ledger lists — the
    // band sums what its own filtered view shows, nothing else. Null (no
    // query) unless a trip filter is active.
    tripLabel === null
      ? null
      : prisma.transaction.aggregate({
          where,
          _count: true,
          _sum: { amount: true },
          _min: { date: true },
          _max: { date: true },
        }),
    tripLabel === null ? 0 : prisma.transaction.count({ where: { ...where, flow: "TRANSFER" } }),
    // The group's TOTAL row count, deliberately UNfiltered — the rename
    // control rewrites the whole group and its scope line must say how much
    // that is, not how much the current filters happen to show.
    tripLabel === null ? 0 : prisma.transaction.count({ where: { groupLabel: tripLabel } }),
  ]);

  // The account column, without joining Account onto every row: `accounts` is
  // the whole table and `accountId` is a required FK, so this cannot miss.
  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));

  // The pattern a row WOULD be tracked under, derived exactly as the action
  // derives it, so "already tracked" is decided by the same rule that writes.
  const trackedPatterns = new Set(trackedSubs.map((s) => s.merchantPattern));
  const subscriptionPattern = (t: { normalizedMerchant: string; description: string; amount: unknown; date: Date }) =>
    draftSubscription({
      normalizedMerchant: t.normalizedMerchant,
      description: t.description,
      amount: Number(t.amount),
      date: t.date,
      cadence: "MONTHLY",
    })?.merchantPattern ?? null;

  // Every month with data, newest first — the period select's options, and the
  // month-stepping links below.
  const monthOptions: string[] = [];
  if (dateRange._min.date !== null && dateRange._max.date !== null) {
    let cursor = new Date(Date.UTC(dateRange._max.date.getUTCFullYear(), dateRange._max.date.getUTCMonth(), 1));
    const first = periodKey(dateRange._min.date, "MONTH");
    for (;;) {
      const key = periodKey(cursor, "MONTH");
      monthOptions.push(key);
      if (key === first || monthOptions.length > 240) break;
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
    }
  }

  // Reimbursement candidates. Ranking lives in suggestReimbursements: amount
  // evidence (exact repayment, or a clean 1/n share of a split) leads, with
  // date proximity breaking ties — sorting by date alone puts last night's rent
  // payment above the dinner a $116.63 Zelle actually pays back.
  //
  // The page ranks every inflow but SERIALIZES only the strong-match hint the
  // collapsed button renders; the full list is fetched when a picker opens
  // (`suggestCandidates` in actions.ts), through the same finder, so what
  // opens is what would have been embedded. A page of this ledger was
  // carrying 400+ candidate objects in its HTML for pickers nobody opened.
  const inflowDates = rows.filter((t) => t.flow === "INFLOW").map((t) => t.date.getTime());
  const DAY_MS = 86_400_000;
  const candidatePool =
    inflowDates.length === 0
      ? []
      : await prisma.transaction.findMany({
          where: {
            flow: "OUTFLOW",
            date: {
              gte: new Date(Math.min(...inflowDates) - REIMBURSE_WINDOW_DAYS * DAY_MS),
              lte: new Date(Math.max(...inflowDates) + REIMBURSE_LEAD_DAYS * DAY_MS),
            },
          },
          // Scalars only. This is the one query that cannot join the
          // Promise.all — its date window comes from the fetched rows — so its
          // round trip is paid in full, and `include: { category: true }` made
          // it 67.6ms of the page's ~131ms data budget on the deployment. The
          // only thing the join supplied was a category NAME, and `categories`
          // is already in memory a few lines above.
          select: {
            id: true,
            amount: true,
            date: true,
            categoryId: true,
            normalizedMerchant: true,
            description: true,
          },
          // id breaks same-date ties so this query and the action's narrow one
          // truncate and rank identically.
          orderBy: [{ date: "desc" }, { id: "desc" }],
          take: REIMBURSE_POOL_TAKE,
        });
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const candidatesFor = makeCandidateFinder(
    candidatePool.map((o) => ({ ...o, amount: Number(o.amount) })),
    (categoryId) => (categoryId === null ? null : (categoryNameById.get(categoryId) ?? null)),
  );
  // The collapsed control's dot and tooltip: the FIRST strong candidate in
  // ranked order, or nothing. This is all an unopened row ships.
  const accountTypeById = new Map(accounts.map((a) => [a.id, a.type]));
  const isNonReimbursable = (accountId: string) =>
    NON_REIMBURSABLE_ACCOUNT_TYPES.has(accountTypeById.get(accountId) ?? "");
  const strongHintFor = (inflow: { date: Date; amount: unknown; accountId: string }) => {
    const best = candidatesFor({
      amount: Number(inflow.amount),
      date: inflow.date,
      accountType: accountTypeById.get(inflow.accountId),
    }).find((c) => c.strong);
    return best === undefined ? null : { label: best.label, reason: best.reason };
  };

  // The only half of "needs review" that SQL cannot express, kept separate so
  // the pool query — which already constrains category and reimbursement in
  // SQL — does not have to select columns it has by construction.
  const isP2P = (t: { normalizedMerchant: string; description: string }) =>
    P2P_PATTERN.test(t.normalizedMerchant) || P2P_PATTERN.test(t.description);
  const needsReview = (t: { normalizedMerchant: string; description: string; categoryId: string | null; reimbursesId: string | null }) =>
    t.categoryId === null &&
    t.reimbursesId === null && // linked to its expense = resolved
    isP2P(t);
  const reviewCount = reviewPool.filter(isP2P).length;

  // In review mode the whole filtered set is in memory, so the page is a slice
  // of it. Otherwise SQL already returned exactly this page.
  const reviewRows = reviewMode ? rows.filter(needsReview) : null;
  const visible = reviewRows === null ? rows : reviewRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const matchCount = reviewRows === null ? total : reviewRows.length;
  const pageCount = Math.max(1, Math.ceil(matchCount / PAGE_SIZE));
  const firstShown = matchCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = (page - 1) * PAGE_SIZE + visible.length;
  // `page` is floored at 1 when it is parsed and was never capped, so a
  // bookmarked or hand-edited ?page= past the end printed "9801–9800 of 1043"
  // over an empty table whose empty state blamed the filters — on a filter set
  // that matched 2,703 rows. Clamping at parse time would need `total`, which
  // costs a round trip to learn something the count in flight already knows,
  // so the request is answered honestly instead: no invented range, an empty
  // state that names the real page count, and a way back in one click.
  const pastEnd = matchCount > 0 && page > pageCount;

  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name, isIncome: c.isIncome }));

  // Named only when the selection covers more than one category, since a single
  // one is already visible in the select.
  const selectedNames: string[] | null =
    selection === null || selection.ids.length + (selection.uncategorized ? 1 : 0) < 2
      ? null
      : [
          ...selection.ids.map((id) => categories.find((c) => c.id === id)?.name ?? id),
          ...(selection.uncategorized ? ["Uncategorized"] : []),
        ];

  // The known trip labels, and the band's facts when a trip filter is active.
  const tripLabels = groupLabelRows.map((r) => r.groupLabel).filter((l): l is string => l !== null);
  const tripBand =
    tripTotals === null
      ? null
      : {
          count: tripTotals._count,
          net: Number(tripTotals._sum.amount ?? 0),
          first: tripTotals._min.date,
          last: tripTotals._max.date,
        };

  // Grouped review: one decision per payee across the ENTIRE uncategorized
  // backlog (not just the visible page), highest-leverage payee first. A few
  // hundred transactions are typically only a few dozen payees.
  // (`?payees=1` — this mode owned `?group=` until trips claimed the name.)
  const groupMode = params.payees === "1";
  let groups: PayeeGroupView[] = [];
  if (groupMode) {
    const uncategorized = await prisma.transaction.findMany({
      where: { ...where, categoryId: null, flow: { not: "TRANSFER" }, reimbursesId: null },
      select: { id: true, amount: true, description: true, normalizedMerchant: true, flow: true },
    });
    groups = groupByPayee(uncategorized.map((t) => ({ ...t, amount: Number(t.amount) }))).map((g) => ({
      key: g.key,
      label: titleCase(g.key),
      matchField: g.matchField,
      isP2P: g.isP2P,
      count: g.count,
      total: money(g.total),
      samples: g.samples,
      flow: g.flow,
    }));
  }
  const groupedTxnCount = groups.reduce((sum, g) => sum + g.count, 0);

  // Month stepping is a convenience now rather than the only way back. It used
  // to be the only one: the list stopped at its cap with no paging, and nothing
  // hinted the period filter was the route to older rows — 718 of 1,018 were
  // unreachable. This is a LEDGER, so pagination above covers every row and
  // these links just make "the month before this one" one click.
  const selectedIdx =
    params.period === undefined || params.period === "" ? -1 : monthOptions.indexOf(params.period);
  // With no period selected the fallback named the month of the LAST VISIBLE
  // ROW — a month already filling the screen. Page 1 offered "← older (July
  // 2026)" while every row on it said July 2026, and page 11 offered June 2024,
  // the oldest month in the database, with nothing older to reach. Step PAST
  // the last row's month to the first month this page does not already show;
  // running out means there is nothing older, and the link is correctly absent.
  const lastVisibleMonth =
    visible.length === 0 ? null : periodKey(visible[visible.length - 1].date, "MONTH");
  const olderPeriod =
    selectedIdx >= 0
      ? (monthOptions[selectedIdx + 1] ?? null)
      : total > visible.length && lastVisibleMonth !== null
        ? (monthOptions[monthOptions.indexOf(lastVisibleMonth) + 1] ?? null)
        : null;
  const newerPeriod = selectedIdx > 0 ? monthOptions[selectedIdx - 1] : null;

  return (
    <div className="py-5">
      <form className="flex flex-wrap items-end gap-3 border-b border-ink pb-3" action="/transactions" method="get">
        {/* The filters DO apply to the grouped query, but a GET form only
            submits its own fields — without this, "review just June" dropped
            you out of the queue and into the flat list. The trip filter needs
            the same synthetic entry: it has no visible control here, so a
            form submit would silently drop it. So does `review`, which is a
            SEPARATE mode from `payees` and kept its bug through the fix that
            named it: the comment above described the P2P queue while the
            input below covered the payee queue. Every mode with no visible
            control belongs on this list. */}
        {groupMode && <input type="hidden" name="payees" value="1" />}
        {reviewMode && <input type="hidden" name="review" value="1" />}
        {tripLabel !== null && <input type="hidden" name="group" value={tripLabel} />}
        <label className="grid gap-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-faint">
          Period
          <select
            name="period"
            defaultValue={params.period ?? ""}
            className="rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink max-md:min-h-[44px]"
          >
            <option value="">All</option>
            {monthOptions.map((key) => (
              <option key={key} value={key}>
                {monthLabel(key)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-faint">
          Category
          <select name="category" defaultValue={params.category ?? ""} className="rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink max-md:min-h-[44px]">
            <option value="">All</option>
            <option value="uncategorized">Uncategorized</option>
            {/* A multi-category arrival (the donut's "Other") matches no single
                option, so the select would read "All" while a filter was
                applied — and submitting the form would then silently drop it.
                Naming the set keeps the control honest and round-trippable. */}
            {selectedNames !== null && params.category !== undefined && (
              <option value={params.category}>{selectedNames.length} categories</option>
            )}
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-faint">
          Account
          <select name="account" defaultValue={params.account ?? ""} className="max-w-[160px] rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink max-md:min-h-[44px]">
            <option value="">All</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-faint">
          Flow
          <select name="flow" defaultValue={params.flow ?? ""} className="rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink max-md:min-h-[44px]">
            <option value="">All</option>
            <option value="OUTFLOW">Outflow</option>
            <option value="INFLOW">Inflow</option>
            <option value="TRANSFER">Transfer</option>
          </select>
        </label>
        <label className="grid flex-1 gap-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-faint">
          Search
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Merchant or description"
            className="min-w-40 rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink max-md:min-h-[44px]"
          />
        </label>
        <button className="rounded-[2px] border border-ink px-3 py-1 text-[0.78rem] uppercase tracking-[0.08em] hover:bg-chip">
          Filter
        </button>
        <Link
          href={groupMode ? "/transactions?payees=1" : "/transactions"}
          className="pb-1.5 text-[0.75rem] uppercase tracking-[0.08em] text-faint hover:text-ink"
        >
          Clear
        </Link>
      </form>

      <div className="flex items-center gap-5 py-2 text-[0.78rem] text-faint">
        <span className="font-money">
          {groupMode
            ? `${groups.length} payees · ${groupedTxnCount} uncategorized`
            : matchCount === 0
              ? "0 matching"
              : pastEnd
                ? `${matchCount} matching`
                : `${firstShown}–${lastShown} of ${matchCount}`}
        </span>
        {/* Which categories, spelled out. A title= would be invisible on touch,
            which is where a donut slice is most likely to have been tapped. */}
        {selectedNames !== null && !groupMode && (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-ink">{selectedNames.join(", ")}</span>
            <Link
              href={buildHref(params, { category: undefined, page: undefined })}
              className="font-semibold text-acc hover:underline"
            >
              clear categories
            </Link>
          </span>
        )}
        {tripLabel !== null && !groupMode && (
          <Link
            href={buildHref(params, { group: undefined, page: undefined })}
            className="font-semibold text-acc hover:underline"
          >
            clear trip
          </Link>
        )}
        {groupMode ? (
          <Link href={buildHref(params, { payees: undefined, page: undefined })} className="font-semibold text-acc hover:underline">
            ← transaction list
          </Link>
        ) : (
          // A bordered control, not body text: this was styled identically to
          // "← all transactions" while being the highest-leverage thing on the
          // screen — Overview's red pill sold it better than its own page did.
          <Link
            href={buildHref(params, { payees: "1", category: "uncategorized", review: undefined, page: undefined })}
            className="rounded-[2px] border border-acc px-2 py-1 font-semibold uppercase tracking-[0.06em] text-acc hover:bg-chip"
            title="Group the uncategorized backlog by payee — one decision categorizes every occurrence and future ones too"
          >
            group by payee — categorize in bulk
          </Link>
        )}
        {!groupMode && olderPeriod !== null && (
          <Link
            href={buildHref(params, { period: olderPeriod, page: undefined })}
            className="font-semibold text-acc hover:underline"
            title={`Jump to ${monthLabel(olderPeriod)}`}
          >
            ← older ({monthLabel(olderPeriod)})
          </Link>
        )}
        {!groupMode && newerPeriod !== null && (
          <Link href={buildHref(params, { period: newerPeriod, page: undefined })} className="font-semibold text-acc hover:underline">
            newer ({monthLabel(newerPeriod)}) →
          </Link>
        )}
        {/* This is a LEDGER: every row has to be reachable. The list used to
            stop at its cap with no way past it, which hid 539 rows across 8
            months once the default narrowed to a single month. Pagination is
            also cheaper than the alternative — a page stays ~PAGE_SIZE rows of
            DOM however many years accumulate. */}
        {!groupMode && pageCount > 1 && (
          <span className="ml-auto flex items-center gap-3 font-money">
            {page > 1 ? (
              // From past the end, "newer" is the last REAL page — stepping to
              // page − 1 would walk back through empty pages one at a time.
              <Link
                href={buildHref(params, {
                  page: (pastEnd ? pageCount : page - 1) === 1 ? undefined : String(pastEnd ? pageCount : page - 1),
                })}
                className="font-semibold text-acc hover:underline"
              >
                ‹ newer
              </Link>
            ) : (
              <span className="text-faint">‹ newer</span>
            )}
            <span>
              page {page} of {pageCount}
            </span>
            {page < pageCount ? (
              <Link href={buildHref(params, { page: String(page + 1) })} className="font-semibold text-acc hover:underline">
                older ›
              </Link>
            ) : (
              <span className="text-faint">older ›</span>
            )}
          </span>
        )}
        {!groupMode &&
          (params.review === "1" ? (
          <Link href={buildHref(params, { review: undefined, page: undefined })} className="font-semibold text-acc hover:underline">
            ← all transactions
          </Link>
        ) : (
            reviewCount > 0 && (
              <Link href={buildHref(params, { review: "1", page: undefined })} className="font-semibold text-neg hover:underline">
                {reviewCount} P2P payment{reviewCount === 1 ? " needs" : "s need"} review — Zelle/Venmo can&apos;t
                be auto-categorized safely
              </Link>
            )
          ))}
      </div>

      {/* The trip's totals band: label, row count, span, sum — FACTS about
          exactly the filtered view below it, stated once, above the table
          (the Overview grouping-figures idiom: a summary is a band, never a
          row). The sum is the signed net of every row this view shows —
          transfers included when the view includes them, and the wording says
          so, because a band that disagrees with the table under it is the
          two-totals bug. */}
      {tripLabel !== null && tripBand !== null && !groupMode && !reviewMode && (
        <div className="mb-1 flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b-2 border-ink bg-chip px-3 py-2 text-[0.85rem]">
          <span className="font-semibold">{tripLabel}</span>
          {/* Rename renders whenever the GROUP exists — even when the current
              filters show none of its rows — because it acts on the whole
              group, not the view. */}
          {tripGroupTotal > 0 && (
            <RenameGroup label={tripLabel} totalRows={tripGroupTotal} labels={tripLabels} />
          )}
          {tripBand.count === 0 || tripBand.first === null || tripBand.last === null ? (
            <span className="text-faint">no rows carry this tag under these filters</span>
          ) : (
            <>
              <span className="font-money tabular text-faint">
                {tripBand.count} row{tripBand.count === 1 ? "" : "s"}
              </span>
              <span className="font-money tabular text-faint">
                {isoDate(tripBand.first)} → {isoDate(tripBand.last)}
              </span>
              <span className="ml-auto font-money tabular font-semibold">net {money(tripBand.net)}</span>
              <span className="w-full text-[0.72rem] text-faint">
                the signed sum of the rows this view shows
                {tripTransfers > 0 &&
                  ` — including ${tripTransfers} transfer${tripTransfers === 1 ? "" : "s"}, which spending analytics still exclude`}
              </span>
            </>
          )}
        </div>
      )}

      {groupMode ? (
        <GroupedReview groups={groups} categories={categoryOptions} />
      ) : (
      // The category list crosses the wire ONCE, here, instead of being
      // serialized into all ~228 rows that carry a control. The trip picker
      // follows the same economics: one portal, labels serialized once.
      <GroupPickerProvider labels={tripLabels}>
      <CategoryPickerProvider categories={categoryOptions}>
      <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-ink">
            {COLUMNS.map((c) => (
              <th
                key={c.label}
                className={`py-1 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint ${c.className}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((t) => {
            const review = needsReview(t);
            return (
              <tr key={t.id} className={`border-b border-rule ${t.flow === "TRANSFER" ? "opacity-60" : ""}`}>
                <td className="py-1.5 pr-3 font-money text-[0.78rem] tabular text-faint">{isoDate(t.date)}</td>
                <td className="max-w-[150px] truncate py-1.5 pr-3 text-[0.85rem] md:max-w-[280px]" title={t.description}>
                  {merchantLabel(t).label}
                  {review && (
                    <span className="ml-2 rounded-[2px] bg-neg px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.05em] text-paper">
                      review
                    </span>
                  )}
                  {/* The AMOUNT joins this sub-line below md. Its own column
                      sat 111px past the right edge of a scroller whose
                      scrollbar is hidden and whose page body does not scroll,
                      so a ledger row showed date, merchant and category and
                      neither the number nor its direction — on the one screen
                      whose entire purpose is the number. The flow word was
                      being truncated away too (96 of 100 rows), taking the
                      direction with it, so it moves to the front where it
                      survives and the account name absorbs the truncation. */}
                  <span className={`flex items-baseline gap-1.5 text-[0.68rem] md:hidden ${FLOW_BADGE[t.flow]}`}>
                    <span className="shrink-0">{t.flow.toLowerCase()}</span>
                    <span className="min-w-0 flex-1 truncate">
                      · {accountNameById.get(t.accountId) ?? ""}
                    </span>
                    <span
                      className={`shrink-0 font-money tabular ${
                        Number(t.amount) < 0 && t.flow !== "TRANSFER"
                          ? "font-semibold text-neg"
                          : Number(t.amount) > 0 && t.flow === "INFLOW"
                            ? "font-semibold text-pos"
                            : ""
                      }`}
                    >
                      {amount(Number(t.amount))}
                    </span>
                  </span>
                </td>
                <td className="hidden py-1.5 pr-3 text-[0.75rem] text-faint md:table-cell">
                  {accountNameById.get(t.accountId) ?? ""}
                </td>
                <td className="py-1.5 pr-3">
                  {t.flow === "TRANSFER" ? (
                    // The word itself is the trip trigger — same text, same
                    // element count, so an untagged ledger page pays nothing.
                    t.groupLabel === null ? (
                      <GroupTrigger
                        transactionId={t.id}
                        groupLabel={null}
                        rowLabel={merchantLabel(t).label || "this transfer"}
                        className="text-[0.75rem] text-faint hover:text-ink"
                        title="Transfers are excluded from spending analytics and carry no category — but one can be tagged into a trip/project"
                      >
                        transfer
                      </GroupTrigger>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <GroupTrigger
                          transactionId={t.id}
                          groupLabel={t.groupLabel}
                          rowLabel={merchantLabel(t).label || "this transfer"}
                          className="text-[0.75rem] text-faint hover:text-ink"
                          title="Transfers are excluded from spending analytics and carry no category — but one can be tagged into a trip/project"
                        >
                          transfer
                        </GroupTrigger>
                        <GroupChip
                          transactionId={t.id}
                          groupLabel={t.groupLabel}
                          rowLabel={merchantLabel(t).label || "this transfer"}
                        />
                      </span>
                    )
                  ) : t.flow === "INFLOW" && t.reimburses !== null ? (
                    <span className="inline-flex items-center gap-1.5">
                    <ReimburseControl
                      inflowId={t.id}
                      linked={{
                        label: titleCase(
                          t.reimburses.normalizedMerchant !== ""
                            ? t.reimburses.normalizedMerchant
                            : t.reimburses.description.toLowerCase(),
                        ),
                        date: isoDate(t.reimburses.date),
                      }}
                      strongHint={null}
                    />
                    {/* A linked reimbursement loses the category control, so
                        it needs its own way into the trip picker — the one
                        row shape that pays an element for it. */}
                    {t.groupLabel === null ? (
                      <GroupTrigger
                        transactionId={t.id}
                        groupLabel={null}
                        rowLabel={merchantLabel(t).label || "this transaction"}
                        className="rounded-[2px] border border-rule px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc"
                        title="Tag this reimbursement into a trip/project"
                      >
                        trip
                      </GroupTrigger>
                    ) : (
                      <GroupChip
                        transactionId={t.id}
                        groupLabel={t.groupLabel}
                        rowLabel={merchantLabel(t).label || "this transaction"}
                      />
                    )}
                    </span>
                  ) : (
                    // Wraps below md: the trigger and the `rule` opener side by
                    // side forced a 162px column, which is what kept the table
                    // 33px wider than its scroller. Stacking them costs row
                    // height, which a phone has, instead of width, which it
                    // does not.
                    <span className="inline-flex items-center gap-1.5">
                      {(() => {
                        // Outflows only: a subscription is something you are
                        // billed for, so an inflow has nothing to declare.
                        const pattern = t.flow === "OUTFLOW" ? subscriptionPattern(t) : null;
                        // One source for the label and the rule target, so the
                        // row you read is the row you act on.
                        const label = merchantLabel(t);
                        return (
                          <CategoryButton
                            transactionId={t.id}
                            merchant={label.label}
                            ruleValue={label.ruleValue}
                            ruleField={label.ruleField}
                            categoryId={t.categoryId}
                            categorySource={t.categorySource}
                            subscriptionPattern={pattern}
                            subscriptionTracked={pattern !== null && trackedPatterns.has(pattern)}
                            groupLabel={t.groupLabel}
                          />
                        );
                      })()}
                      {/* Money arriving in a brokerage or an IRA is not a
                          friend settling up, so the control is absent rather
                          than merely unhinted — every strong suggestion on
                          page 1 was a dividend, two of them inside IRAs. A
                          row already LINKED still renders its chip above, so
                          nothing existing becomes unreachable. */}
                      {t.flow === "INFLOW" && !isNonReimbursable(t.accountId) && (
                        <ReimburseControl inflowId={t.id} linked={null} strongHint={strongHintFor(t)} />
                      )}
                      {/* Tagged rows carry their chip; untagged rows carry
                          NOTHING — their way in is the actions menu, which
                          renders on demand (the DOM-size lesson). */}
                      {t.groupLabel !== null && (
                        <GroupChip
                          transactionId={t.id}
                          groupLabel={t.groupLabel}
                          rowLabel={merchantLabel(t).label || "this transaction"}
                        />
                      )}
                    </span>
                  )}
                </td>
                <td className={`hidden py-1.5 pr-3 text-[0.68rem] uppercase tracking-[0.06em] md:table-cell ${FLOW_BADGE[t.flow]}`}>
                  {t.flow.toLowerCase()}
                </td>
                <td
                  className={`hidden py-1.5 text-right font-money text-[0.85rem] tabular md:table-cell ${
                    Number(t.amount) < 0 && t.flow !== "TRANSFER" ? "font-semibold text-neg" : Number(t.amount) > 0 && t.flow === "INFLOW" ? "font-semibold text-pos" : ""
                  }`}
                >
                  {amount(Number(t.amount))}
                </td>
              </tr>
            );
          })}
          {visible.length === 0 && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-[0.85rem] text-faint">
                {pastEnd ? (
                  <>
                    Page {page} is past the end — these filters match {matchCount} rows across{" "}
                    {pageCount} page{pageCount === 1 ? "" : "s"}.{" "}
                    <Link
                      href={buildHref(params, { page: pageCount === 1 ? undefined : String(pageCount) })}
                      className="font-semibold text-acc hover:underline"
                    >
                      go to page {pageCount}
                    </Link>
                  </>
                ) : (
                  "No transactions match these filters."
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
      </CategoryPickerProvider>
      </GroupPickerProvider>
      )}
    </div>
  );
}
