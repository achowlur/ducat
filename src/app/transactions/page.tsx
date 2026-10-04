import Link from "next/link";
import type { Prisma } from "../../generated/prisma/client";
import { AccountFilter } from "../../components/AccountFilter";
import { CategoryButton, CategoryPickerProvider, RowRefusal } from "../../components/CategoryPicker";
import { GroupChip, GroupPickerProvider, GroupTrigger } from "../../components/GroupPicker";
import { RenameGroup } from "../../components/RenameGroup";
import { GroupedReview, type PayeeGroupView } from "../../components/GroupedReview";
import { ReimburseControl } from "../../components/ReimburseControl";
import { draftSubscription } from "../../lib/health/registerSubscription";
import { prisma } from "../../lib/prisma";
import { parsePeriodParam, spanLabel } from "../../lib/ui/periodSpan";
import {
  makeCandidateFinder,
  NON_REIMBURSABLE_ACCOUNT_TYPES,
  REIMBURSE_LEAD_DAYS,
  REIMBURSE_POOL_TAKE,
  REIMBURSE_WINDOW_DAYS,
} from "../../lib/ui/reimburseCandidates";
import { groupByPayee } from "../../lib/sync/grouping";
import { P2PSuggestion } from "../../components/P2PSuggestion";
import { isP2P, isUnreviewedP2P, P2P_PREFILTER_WORDS, P2P_UNREVIEWED_ID, P2P_UNREVIEWED_NAME } from "../../lib/p2p";
import { suggestP2PCategories } from "../../lib/sync/p2pSuggest";
import { USER_PRIORITY_MAX } from "../../lib/sync/rules";
import { amount, isoDate, money, monthLabel, shortDate, titleCase } from "../../lib/ui/format";
import { periodKey } from "../../lib/insights/periods";
import { encodeAccountParam, parseAccountParam } from "../../lib/ui/accountFilter";
import { nullBucketFilter, parseCategoryParam } from "../../lib/ui/categoryFilter";
import { finishedInMemory, flowFinish, parseFlowParam, sqlFlow } from "../../lib/ui/flowFilter";
import { parseGroupParam } from "../../lib/ui/groupFilter";
import { ledgerTotals, type LedgerTotals } from "../../lib/ui/ledgerTotals";
import { repaidByExpense, repaidFromOutside, repaidNote } from "../../lib/ui/repaid";
import { merchantKey, merchantLabel } from "../../lib/ui/merchantLabel";
import { COLUMN_HEADER, PageTitle } from "../../components/ui/headings";
import { withDatabaseNotice } from "../../components/DatabaseNotice";

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
  /** One account id or a comma-separated list — owned by ui/accountFilter.ts. */
  account?: string;
  /** A row's own flow, or one of the two figures (SPENDING, INCOME): owned by ui/flowFilter.ts. */
  flow?: string;
  q?: string;
  review?: string;
  page?: string;
  /** Trip/project label filter — owned by ui/groupFilter.ts. */
  group?: string;
  /**
   * One merchant EXACTLY, as /trends totals it: ui/merchantLabel.ts's
   * merchantKey, so a P2P row matches on its payee and never on the rail.
   */
  merchant?: string;
  /** "1" = the group-by-payee bulk review queue (was `group` before trips claimed that name). */
  payees?: string;
}

/**
 * As the URL delivers them. A repeated key arrives as an array, and `account`
 * is the one key here a list is meaningful for; it is made a single canonical
 * value before anything below reads it.
 */
type RawParams = Omit<Params, "account"> & { account?: string | string[] };

function buildHref(params: Params, overrides: Partial<Params>): string {
  const merged = { ...params, ...overrides };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const qs = search.toString();
  return qs === "" ? "/transactions" : `/transactions?${qs}`;
}

/**
 * The pager, extracted so it can render ABOVE and BELOW the table.
 *
 * It existed only at the top of a 4,172px page (5,455px at 375px): you read
 * 100 rows, reached the bottom, and found nothing there — the way to page 2
 * was a full scroll back. Repeating four elements is the cheap half of the
 * fix; `first`/`last` are the other half, since stepping one page at a time
 * made page 7 six round trips. A numbered page list is the obvious third
 * option and is the one this page cannot afford, being the DOM-size lesson
 * the category picker already paid for.
 */
function Pager({
  params,
  page,
  pageCount,
  pastEnd,
}: {
  params: Params;
  page: number;
  pageCount: number;
  pastEnd: boolean;
}) {
  const linkTo = (n: number) => buildHref(params, { page: n === 1 ? undefined : String(n) });
  // From past the end, "newer" is the last REAL page — stepping to page − 1
  // would walk back through empty pages one at a time.
  const newer = pastEnd ? pageCount : page - 1;
  return (
    <span className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 font-money">
      {page > 2 && (
        <Link href={linkTo(1)} className="tap44 font-semibold text-acc hover:underline">
          « first
        </Link>
      )}
      {page > 1 ? (
        <Link href={linkTo(newer)} className="tap44 font-semibold text-acc hover:underline">
          ‹ newer
        </Link>
      ) : (
        <span className="text-faint">‹ newer</span>
      )}
      <span>
        page {page} of {pageCount}
      </span>
      {page < pageCount ? (
        <Link href={linkTo(page + 1)} className="tap44 font-semibold text-acc hover:underline">
          older ›
        </Link>
      ) : (
        <span className="text-faint">older ›</span>
      )}
      {page < pageCount - 1 && (
        <Link href={linkTo(pageCount)} className="tap44 font-semibold text-acc hover:underline">
          last »
        </Link>
      )}
    </span>
  );
}

/**
 * What the list adds up to, rendered ABOVE the rows for everything the
 * filters match and BELOW them for the page on screen.
 *
 * A band and never a row, the trip band's idiom and Overview's before it: a
 * total set in the table's own type reads as one more transaction. The
 * figures sit at the right edge, under the column they sum.
 *
 * Transfers get figures of their own, out and in, on a second line: as a
 * sentence in small type they were the one amount on the band a reader could
 * not compare against the rest. They are still not IN the net, and the line
 * says so beside them, because it is the one part of the view the net leaves
 * out. Two figures and never one: across a whole ledger every transfer out is
 * a transfer in, so their sum is zero however much money moved.
 *
 * A view holding no transfer says that in words and prints no figures. Any
 * category filter is such a view, since a transfer carries no category, and
 * two zeros on every one of them would be the band's loudest line.
 *
 * REPAID appears only when there is some: linked repayments of the bills in
 * view that the view does not list (ui/repaid.ts). Its count is said in words
 * on the second line, since it is the one figure made of rows not on screen.
 */
function TotalsBand({ label, totals, foot }: { label: string; totals: LedgerTotals; foot?: boolean }) {
  const t = totals.transfers;
  const figure = "whitespace-nowrap font-money tabular";
  // The gap after each caption is a real SPACE and not a margin, so the band
  // reads "out $9.99" to a screen reader and to a paste, not "out$9.99".
  const caption = "text-[0.68rem] uppercase tracking-[0.1em] text-faint";
  return (
    <div
      role="group"
      aria-label={label}
      className={`flex flex-wrap items-baseline gap-x-5 gap-y-1 bg-chip px-3 py-2 text-[0.85rem] ${
        foot === true ? "border-t-2 border-ink" : "mb-1 border-b-2 border-ink"
      }`}
    >
      <span className="text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">{label}</span>{" "}
      <span className="ml-auto flex flex-wrap items-baseline justify-end gap-x-5 gap-y-1">
        <span className={figure}>
          <span className={caption}>out</span> {money(totals.out)}
        </span>{" "}
        {/* Beside OUT because it is a part of it coming back: the linked
            repayments of these bills that the view itself does not list. */}
        {totals.repaid.count > 0 && (
          <>
            <span className={figure}>
              <span className={caption}>repaid</span> {money(totals.repaid.amount)}
            </span>{" "}
          </>
        )}
        <span className={figure}>
          <span className={caption}>in</span> {money(totals.in)}
        </span>{" "}
        <span
          className={`${figure} font-semibold ${totals.net < 0 ? "text-neg" : totals.net > 0 ? "text-pos" : ""}`}
        >
          <span className={caption}>net</span> {money(totals.net)}
        </span>
      </span>{" "}
      <span className="flex w-full flex-wrap items-baseline gap-x-5 gap-y-1">
        <span className="text-[0.72rem] text-faint">
          {totals.repaid.count > 0 &&
            `repaid: ${totals.repaid.count.toLocaleString("en-US")} linked repayment${
              totals.repaid.count === 1 ? "" : "s"
            } outside this view · `}
          {t.count === 0
            ? "no transfers in this view"
            : `${t.count.toLocaleString("en-US")} transfer${t.count === 1 ? "" : "s"}, not in the net`}
        </span>{" "}
        {t.count > 0 && (
          <span className="ml-auto flex flex-wrap items-baseline justify-end gap-x-5 gap-y-1">
            <span className={figure}>
              <span className={caption}>transfers out</span> {money(t.out)}
            </span>{" "}
            <span className={figure}>
              <span className={caption}>transfers in</span> {money(t.in)}
            </span>
          </span>
        )}
      </span>
    </div>
  );
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

export default async function TransactionsPage(props: { searchParams: Promise<RawParams> }) {
  return withDatabaseNotice(() => renderTransactions(props));
}

/**
 * Wrapped rather than guarded at each call site: this page builds its queries
 * inline instead of behind a lib/ui getter, and issues them at three points —
 * the Promise.all, the reimbursement candidate pool and the payee queue — with
 * derivation interleaved between them. One wrapper covers all three without
 * touching the Promise.all that performance.md pins as this page's data budget.
 */
async function renderTransactions({ searchParams }: { searchParams: Promise<RawParams> }) {
  const raw = await searchParams;
  // The account filter: any number of accounts, read only through
  // ui/accountFilter.ts. `params` carries it re-encoded, so every link built
  // from `params` below (pager, month step, clear links) keeps the whole list
  // whatever shape it arrived in.
  const accountIds = parseAccountParam(raw.account);
  const params: Params = {
    ...raw,
    account: accountIds === null ? undefined : encodeAccountParam(accountIds),
  };

  const page = Math.max(1, Math.floor(Number(params.page ?? "1")) || 1);

  const where: Prisma.TransactionWhereInput = {};
  // One period key or a span of months, read only through ui/periodSpan.ts.
  // Unparseable is ignored rather than crashing the page.
  const periodFilter = parsePeriodParam(params.period);
  if (periodFilter !== null) where.date = { gte: periodFilter.start, lt: periodFilter.end };
  // A row's own flow, or one of the two figures, read only through
  // ui/flowFilter.ts. Anything else is no flow filter at all.
  const flow = parseFlowParam(params.flow);
  // One id, `uncategorized`, or a comma-separated list of either — the donut's
  // "Other" slice is a SET of categories, so it arrives here enumerated.
  const selection = parseCategoryParam(params.category);
  if (selection !== null) {
    // Both null buckets are `categoryId: null` in SQL; nullBucketFilter below
    // separates Uncategorized from P2P — Unreviewed.
    const nullBucket = selection.uncategorized || selection.p2p;
    if (!nullBucket) {
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
    if (nullBucket && flow === null) {
      where.flow = { not: "TRANSFER" };
    }
  }
  // A plain column test, so it composes with `q`'s top-level OR and the
  // category group in AND without touching either.
  if (accountIds !== null) where.accountId = { in: accountIds };
  // A row's own flow is answered here exactly. The two figures narrow to a
  // superset here and are finished in memory below, by the analyzers' own
  // reimbursement test.
  if (flow !== null) where.flow = sqlFlow(flow);
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
  // The merchant key is DERIVED (a P2P payee comes out of the description), so
  // SQL narrows to a SUPERSET and the list is finished in memory, on the same
  // whole-set path review mode takes. Superset because every key is either the
  // trimmed merchant, or words cut whole from the lowercased description, so
  // its first word is always a case-insensitive substring of one or the other.
  const merchant = params.merchant !== undefined && params.merchant.trim() !== "" ? params.merchant.trim() : null;
  if (merchant !== null) {
    const firstWord = merchant.split(" ")[0];
    const superset: Prisma.TransactionWhereInput = {
      OR: [{ normalizedMerchant: { contains: merchant } }, { description: { contains: firstWord } }],
    };
    where.AND = [...(where.AND === undefined ? [] : Array.isArray(where.AND) ? where.AND : [where.AND]), superset];
  }
  const isMerchant = (t: { normalizedMerchant: string; description: string }) =>
    merchant === null || merchantKey(t) === merchant;

  // Review mode narrows in SQL as far as Prisma can, then finishes in JS: the
  // P2P test is a regex across two columns, which Prisma cannot express. Its
  // candidate set is small by construction, so it is fetched WHOLE and paged in
  // JS — paging in SQL and filtering afterwards gives uneven pages.
  const reviewMode = params.review === "1";
  // Selecting exactly ONE of the two null buckets needs the same in-memory
  // finish as review mode, and the same whole-set fetch. So do the two
  // figures, SPENDING and INCOME.
  const nullSplit = nullBucketFilter(selection);
  const pagedInJs = reviewMode || nullSplit !== null || merchant !== null || finishedInMemory(flow);
  const listWhere: Prisma.TransactionWhereInput = reviewMode
    ? { ...where, categoryId: null, reimbursesId: null, flow: { not: "TRANSFER" } }
    : where;

  const [rows, matching, categories, accounts, dateRange, reviewPool, trackedSubs, groupLabelRows, tripTotals, tripTransfers, tripGroupTotal, linkedRepayments] = await Promise.all([
    prisma.transaction.findMany({
      where: listWhere,
      // A relation `include` is a ROUND TRIP, and this query had three of them
      // for a page that reads one string from two. `category` became dead the
      // moment the category picker started taking `categoryId` instead of the
      // object, and `account` supplies a NAME that `accounts` below already
      // has. Only `reimburses` genuinely needs the database — it points at
      // another transaction, so nothing in memory can answer it — and it is
      // narrowed to the three fields the chip renders, plus the flow that says
      // whether the repayment credits it (ui/flowFilter.ts).
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
        reimburses: { select: { normalizedMerchant: true, description: true, date: true, flow: true } },
      },
      orderBy: { date: "desc" },
      // Paged in SQL for the ledger; review mode, a single null bucket, a
      // merchant and the two figures page in JS after filtering.
      ...(pagedInJs ? {} : { skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    }),
    // Every matching row's flow and amount, for the total above the list.
    // This was a COUNT, and the count is now this set's length, so the total
    // costs no round trip of its own. Narrow columns: a sum grouped by flow
    // would be smaller on the wire, but it cannot tell a transfer out from a
    // transfer in, and asking twice is the cost that matters here. The id says
    // which linked repayments the list already shows (ui/repaid.ts).
    // Null when the list pages in JS, where `rows` is already the whole set.
    pagedInJs
      ? null
      : prisma.transaction.findMany({ where: listWhere, select: { id: true, flow: true, amount: true } }),
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
    // Every linked repayment, whatever the filters: a bill's repayment is
    // usually NOT in its view (it carries another category, or lands in
    // another month), and both the line under the bill and the totals need
    // it. Linked rows only, one per settled share, so the set is small by
    // construction, and it runs inside this group rather than after it.
    prisma.transaction.findMany({
      where: { reimbursesId: { not: null } },
      select: { id: true, reimbursesId: true, flow: true, amount: true },
    }),
  ]);

  const total = matching === null ? rows.length : matching.length;

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
  // The Uncategorized branch quietly adds `flow: { not: TRANSFER }`, which is
  // deliberate and defended above — the control saying "All" over it was not.
  const transfersExcluded = (selection?.uncategorized === true || selection?.p2p === true) && flow === null;
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

  // A P2P payment nobody has confirmed: no category, not a transfer, and not
  // linked to the expense it repays (a link is a decision). The pool query
  // already constrains the SQL half, so its count needs only the P2P test.
  const needsReview = isUnreviewedP2P;
  // The pool is the merchant filter's SQL superset until finished here.
  const pool = reviewPool.filter(isMerchant);
  const reviewCount = pool.filter(isP2P).length;

  // In review mode the whole filtered set is in memory, so the page is a slice
  // of it. Otherwise SQL already returned exactly this page.
  const finish = reviewMode ? needsReview : nullSplit;
  // The two figures turn on a category's isIncome, known only now. Review mode
  // keeps ignoring the flow control, as its SQL always has.
  const incomeCategoryIds = new Set(categories.filter((c) => c.isIncome).map((c) => c.id));
  const keepsFlow = reviewMode ? null : flowFinish(flow, incomeCategoryIds);
  const reviewRows = pagedInJs
    ? rows.filter((t) => (finish === null || finish(t)) && isMerchant(t) && (keepsFlow === null || keepsFlow(t)))
    : null;
  // The merchant filter's name as the rows it matches print it.
  const merchantName =
    merchant === null
      ? null
      : reviewRows !== null && reviewRows.length > 0
        ? merchantLabel(reviewRows[0]).label
        : titleCase(merchant);
  const visible = reviewRows === null ? rows : reviewRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const matchCount = reviewRows === null ? total : reviewRows.length;
  const pageCount = Math.max(1, Math.ceil(matchCount / PAGE_SIZE));
  const firstShown = matchCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = (page - 1) * PAGE_SIZE + visible.length;

  // Both totals are sums of the FILTERED list: the one above the rows takes
  // every row the filters match, across all pages, and the one below takes the
  // rows on this page. Where the list is finished in memory (review mode, a
  // single null bucket) the whole set is the filtered `reviewRows`, so the
  // total counts exactly the rows that can be paged to.
  // The one figure from outside the list is REPAID: linked repayments of its
  // bills that it does not show, which the analyzers net and so must this.
  const linked = linkedRepayments.flatMap((r) =>
    r.reimbursesId === null ? [] : [{ id: r.id, reimbursesId: r.reimbursesId, flow: r.flow, amount: Number(r.amount) }],
  );
  const repaidOf = repaidByExpense(linked);
  const listed = reviewRows ?? matching ?? rows;
  const listedIds = new Set(listed.map((t) => t.id));
  const summable = (t: { flow: string; amount: unknown }) => ({ flow: t.flow, amount: Number(t.amount) });
  const overallTotals = ledgerTotals(listed.map(summable), repaidFromOutside(listed, linked, listedIds));
  const pageTotals = ledgerTotals(visible.map(summable), repaidFromOutside(visible, linked, listedIds));

  // Pre-filled categories for the P2P payments on THIS page awaiting
  // confirmation. Two round trips, paid only when such a row is on screen:
  // the P2P rows already categorized (narrowed in SQL by a superset of the
  // rail words, then decided exactly by isP2P) and the user rules that would
  // once have categorized them.
  const awaiting = visible.filter(needsReview);
  const suggestions = new Map<string, { categoryId: string; categoryName: string; reason: string }>();
  if (awaiting.length > 0) {
    const [historyRows, userRules] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          categoryId: { not: null },
          flow: { not: "TRANSFER" },
          OR: P2P_PREFILTER_WORDS.flatMap((w) => [
            { description: { contains: w } },
            { normalizedMerchant: { contains: w } },
          ]),
        },
        select: { amount: true, date: true, description: true, normalizedMerchant: true, categoryId: true },
      }),
      prisma.rule.findMany({
        where: { enabled: true, priority: { lt: USER_PRIORITY_MAX }, setCategoryId: { not: null }, setFlow: null },
      }),
    ]);
    const found = suggestP2PCategories(
      awaiting.map((t) => ({
        id: t.id,
        amount: Number(t.amount),
        date: t.date,
        description: t.description,
        normalizedMerchant: t.normalizedMerchant,
        accountName: accountNameById.get(t.accountId) ?? "",
        categorySource: t.categorySource as "AGGREGATOR" | "RULE" | "MANUAL",
      })),
      historyRows
        .filter((h) => isP2P(h) && h.categoryId !== null)
        .map((h) => ({ amount: Number(h.amount), date: h.date, description: h.description, categoryId: h.categoryId! })),
      userRules,
    );
    for (const [id, s] of found) {
      const categoryName = categoryNameById.get(s.categoryId);
      if (categoryName === undefined) continue; // a rule naming a deleted category suggests nothing
      const reason =
        s.reason.kind === "SAME_AMOUNT"
          ? `same amount as ${shortDate(s.reason.date)}`
          : s.reason.kind === "RULE"
            ? "your rule for this payee"
            : `${s.reason.count} of ${s.reason.of} past payments`;
      suggestions.set(id, { categoryId: s.categoryId, categoryName, reason });
    }
  }
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
    selection === null || selection.ids.length + (selection.uncategorized ? 1 : 0) + (selection.p2p ? 1 : 0) < 2
      ? null
      : [
          ...selection.ids.map((id) => categories.find((c) => c.id === id)?.name ?? id),
          ...(selection.uncategorized ? ["Uncategorized"] : []),
          ...(selection.p2p ? [P2P_UNREVIEWED_NAME] : []),
        ];

  // Named only when more than one account is selected, since a single one is
  // already spelled out in the control. An id naming no account is left out:
  // it matches no row, so it has no name to print.
  const selectedAccountNames: string[] | null =
    accountIds === null || accountIds.length < 2
      ? null
      : accountIds.flatMap((id) => accountNameById.get(id) ?? []);

  // The known trip labels, and the band's facts when a trip filter is active.
  const tripLabels = groupLabelRows.map((r) => r.groupLabel).filter((l): l is string => l !== null);
  // Wherever the list is finished in memory (a merchant, one null bucket, the
  // two figures) the SQL aggregate covers the superset, so the band sums the
  // finished list instead: it states what its own view shows.
  const bandRows = tripTotals !== null && reviewRows !== null ? reviewRows : null;
  const tripBand =
    tripTotals === null
      ? null
      : bandRows !== null
        ? {
            count: bandRows.length,
            net: bandRows.reduce((sum, t) => sum + Math.round(Number(t.amount) * 100), 0) / 100,
            first: bandRows.length === 0 ? null : bandRows[bandRows.length - 1].date,
            last: bandRows.length === 0 ? null : bandRows[0].date,
          }
        : {
            count: tripTotals._count,
            net: Number(tripTotals._sum.amount ?? 0),
            first: tripTotals._min.date,
            last: tripTotals._max.date,
          };
  const tripTransferCount = bandRows !== null ? bandRows.filter((t) => t.flow === "TRANSFER").length : tripTransfers;

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
    groups = groupByPayee(uncategorized.filter(isMerchant).map((t) => ({ ...t, amount: Number(t.amount) }))).map((g) => ({
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
  // A span is not a month to step from: "older" would jump to one month
  // before its last visible row and silently drop the rest of the span.
  const isSpan = periodFilter !== null && periodFilter.span !== null;
  // With no period selected the fallback named the month of the LAST VISIBLE
  // ROW — a month already filling the screen. Page 1 offered "← older (July
  // 2026)" while every row on it said July 2026, and page 11 offered June 2024,
  // the oldest month in the database, with nothing older to reach. Step PAST
  // the last row's month to the first month this page does not already show;
  // running out means there is nothing older, and the link is correctly absent.
  const lastVisibleMonth =
    visible.length === 0 ? null : periodKey(visible[visible.length - 1].date, "MONTH");
  const olderPeriod = isSpan
    ? null
    : selectedIdx >= 0
      ? (monthOptions[selectedIdx + 1] ?? null)
      : total > visible.length && lastVisibleMonth !== null
        ? (monthOptions[monthOptions.indexOf(lastVisibleMonth) + 1] ?? null)
        : null;
  const newerPeriod = !isSpan && selectedIdx > 0 ? monthOptions[selectedIdx - 1] : null;

  return (
    <div className="py-5">
      <PageTitle>Transactions</PageTitle>
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
        {merchant !== null && <input type="hidden" name="merchant" value={merchant} />}
        <label className="grid gap-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-faint">
          Period
          <select
            name="period"
            defaultValue={params.period ?? ""}
            className="rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink max-md:min-h-[44px]"
          >
            <option value="">All</option>
            {/* A span arriving from /trends matches no month, so it gets the
                synthetic entry the category select gives a set: without it
                the select reads "All" while the span applies, and the next
                submit drops it. */}
            {periodFilter !== null && periodFilter.span !== null && (
              <option value={params.period}>{spanLabel(periodFilter.span.from, periodFilter.span.to)}</option>
            )}
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
            <option value={P2P_UNREVIEWED_ID}>{P2P_UNREVIEWED_NAME}</option>
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
        {/* Keyed by the applied filter: "clear accounts" below is a soft
            navigation, which re-renders this with new props and would leave
            its staged ticks showing a filter that is no longer in force. */}
        <AccountFilter
          key={params.account ?? ""}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name, institution: a.institution }))}
          selected={accountIds ?? []}
        />
        <label className="grid gap-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-faint">
          Flow
          {/* The synthetic entry the category select already needed, for the
              same reason: selecting Uncategorized also applies
              `flow: { not: TRANSFER }`, so this control read "All" while a
              filter was in force. */}
          <select name="flow" defaultValue={flow ?? ""} className="rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink max-md:min-h-[44px]">
            <option value="">{transfersExcluded ? "All except transfers" : "All"}</option>
            <option value="OUTFLOW">Outflow</option>
            <option value="INFLOW">Inflow</option>
            <option value="TRANSFER">Transfer</option>
            {/* The two figures /trends and Overview print, which their links
                open (ui/flowFilter.ts): money out net of what came back, and
                money in that is not a refund or a repayment. */}
            <option value="SPENDING">Spending</option>
            <option value="INCOME">Income</option>
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

      {/* flex-wrap, not nowrap: this strip carries the row count, the payee
          pill, the month step and the pager, and at 375px they were four
          narrow smears of vertical text about 30px wide each. With first/last
          on the pager it overflowed the body outright. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 py-2 text-[0.78rem] text-faint">
        <span className="font-money">
          {groupMode
            ? `${groups.length} payees · ${groupedTxnCount} uncategorized`
            : matchCount === 0
              ? "0 matching"
              : pastEnd
                ? `${matchCount.toLocaleString("en-US")} matching`
                : `${firstShown.toLocaleString("en-US")}–${lastShown.toLocaleString("en-US")} of ${matchCount.toLocaleString("en-US")}`}
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
        {/* Which accounts, spelled out, for the reason the categories are: the
            control can only say "3 accounts". */}
        {selectedAccountNames !== null && selectedAccountNames.length > 0 && (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-ink">{selectedAccountNames.join(", ")}</span>
            <Link
              href={buildHref(params, { account: undefined, page: undefined })}
              className="font-semibold text-acc hover:underline"
            >
              clear accounts
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
        {/* The two figures leave rows out that a row's own flow would list,
            so each says which, beside the way back to all of them. */}
        {flow === "SPENDING" && !groupMode && (
          <span className="flex flex-wrap items-center gap-2">
            <span>spending: money out, less its refunds and repayments</span>
            <Link
              href={buildHref(params, { flow: undefined, page: undefined })}
              className="tap44 font-semibold text-acc hover:underline"
            >
              every row
            </Link>
          </span>
        )}
        {flow === "INCOME" && !groupMode && (
          <span className="flex flex-wrap items-center gap-2">
            <span>income: refunds and repayments count against spending instead</span>
            <Link
              href={buildHref(params, { flow: "INFLOW", page: undefined })}
              className="tap44 font-semibold text-acc hover:underline"
            >
              all money in
            </Link>
          </span>
        )}
        {/* The merchant filter has no control of its own, so it is spelled out
            here, where it can also be dropped. */}
        {merchant !== null && (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-ink">{merchantName}</span>
            <Link
              href={buildHref(params, { merchant: undefined, page: undefined })}
              className="font-semibold text-acc hover:underline"
            >
              clear merchant
            </Link>
          </span>
        )}
        {groupMode ? (
          <Link href={buildHref(params, { payees: undefined, page: undefined })} className="font-semibold text-acc hover:underline">
            ← transaction list
          </Link>
        ) : (
          // A bordered control, not body text: this was styled identically to
          // "← all transactions" while being the highest-leverage thing on the
          // screen — Overview's red pill sold it better than its own page did.
          pool.length === 0 ? (
            // The mirror of Overview's review panel: THAT one had to learn to
            // state "all clear" instead of implying it by absence, and this one
            // has the opposite failure — the boldest control on the ledger urged
            // you into a backlog that has been empty for months, so "there is
            // work" could not be told from "there is none". reviewPool is
            // already queried over the same constraints, so the gate is free.
            <span className="text-faint">no uncategorized rows</span>
          ) : (
          <Link
            href={buildHref(params, { payees: "1", category: "uncategorized", review: undefined, page: undefined })}
            className="tap44 rounded-[2px] border border-acc px-2 py-1 font-semibold uppercase tracking-[0.06em] text-acc hover:bg-chip"
            title="Group the uncategorized backlog by payee: one decision categorizes every occurrence and future ones too"
          >
            group by payee to categorize in bulk
          </Link>
          )
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
          <Pager params={params} page={page} pageCount={pageCount} pastEnd={pastEnd} />
        )}
        {!groupMode &&
          (params.review === "1" ? (
          <Link href={buildHref(params, { review: undefined, page: undefined })} className="font-semibold text-acc hover:underline">
            ← all transactions
          </Link>
        ) : (
            reviewCount > 0 && (
              <Link href={buildHref(params, { review: "1", page: undefined })} className="font-semibold text-neg hover:underline">
                {reviewCount} P2P payment{reviewCount === 1 ? "" : "s"} to confirm. Zelle/Venmo never
                categorize without you; tap ✓ to accept a suggestion
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
                {tripTransferCount > 0 &&
                  `, including ${tripTransferCount} transfer${tripTransferCount === 1 ? "" : "s"}, which spending analytics still exclude`}
              </span>
            </>
          )}
        </div>
      )}

      {/* Below the trip band when there is one, and not instead of it: that
          band's net is the signed sum of every tagged row, transfers
          included, and this one states its transfers apart. */}
      {!groupMode && matchCount > 0 && (
        <TotalsBand label={`All ${matchCount.toLocaleString("en-US")} matching`} totals={overallTotals} />
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
                scope="col"
                key={c.label}
                className={`py-1 ${COLUMN_HEADER} ${c.className}`}
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
              // The de-emphasis stays — a transfer carries no decision about
              // spending and reads as noise at full weight — but it stops
              // being blanket ROW opacity. At 0.6 the row's amount fell to
              // 3.45:1 and its `transfer` cell to 2.36:1 in sepia, failing AA
              // and even the 3:1 non-text bar in all three themes. That cell
              // is not decoration any more: since 2026-08-02 its own text IS
              // the trip trigger, so the lowest-contrast thing on the page was
              // an interactive control. The backlog's argument for dimming
              // ("a plain 'transfer' span... the label is decoration on a row
              // that carries no decision") predates that change and its
              // tooltip half was always desktop-only. Merchant and account
              // keep the dimming; date, amount and the trigger do not.
              <tr key={t.id} className="border-b border-rule">
                {/* Below md the ISO form wrapped at its own hyphen on every row
                    (2026-⏎09-20); the short form fits on one line at the same width. */}
                <td className="whitespace-nowrap py-1.5 pr-3 font-money text-[0.78rem] tabular text-faint">
                  <span className="md:hidden">{shortDate(t.date)}</span>
                  <span className="hidden md:inline">{isoDate(t.date)}</span>
                </td>
                {/* The dimming sits on the LABEL, not the cell: below md the
                    amount lives in this cell's sub-line, and dimming the cell
                    took the number down to 2.71:1 with it — reintroducing the
                    exact defect one element lower. */}
                <td
                  className="max-w-[150px] py-1.5 pr-3 text-[0.85rem] md:max-w-[280px]"
                  title={t.description}
                >
                  {/* The truncation belongs to the LABEL, not the cell: on the
                      cell it clipped the REVIEW chip to an empty red block
                      whenever the merchant filled the width. */}
                  <span className="flex items-baseline gap-2">
                    <span className={`min-w-0 truncate ${t.flow === "TRANSFER" ? "opacity-60" : ""}`}>
                      {merchantLabel(t).label}
                    </span>
                    {review && (
                      <span className="shrink-0 rounded-[2px] bg-neg px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.05em] text-paper">
                        review
                      </span>
                    )}
                  </span>
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
                    <span className={`shrink-0 ${t.flow === "TRANSFER" ? "opacity-60" : ""}`}>
                      {t.flow.toLowerCase()}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate ${t.flow === "TRANSFER" ? "opacity-60" : ""}`}
                    >
                      · {accountNameById.get(t.accountId) ?? ""}
                    </span>
                    {/* The figure keeps the desktop column's size; it was the
                        smallest text in the row, below the account name it
                        shares a line with. */}
                    <span
                      className={`shrink-0 font-money text-[0.85rem] tabular ${
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
                  {/* What came back on a bill and what that leaves it costing,
                      at every width. The link lives on the repayment, so this
                      row was the one place in the ledger that never said it:
                      a category view listed the whole charge while /trends,
                      one click back, had already netted it. */}
                  {t.flow === "OUTFLOW" &&
                    (() => {
                      const r = repaidOf.get(t.id);
                      return r === undefined ? null : (
                        <span className="block text-[0.68rem] text-faint">{repaidNote(Number(t.amount), r)}</span>
                      );
                    })()}
                </td>
                <td
                  className={`hidden py-1.5 pr-3 text-[0.75rem] text-faint md:table-cell ${
                    t.flow === "TRANSFER" ? "opacity-60" : ""
                  }`}
                >
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
                        title="Transfers are excluded from spending analytics and carry no category, but one can be tagged into a trip/project"
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
                          title="Transfers are excluded from spending analytics and carry no category, but one can be tagged into a trip/project"
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
                  {/* Why this row's last write was refused, on its own line
                      for the same reason as the suggestion below; renders
                      nothing until there is something to say. */}
                  <RowRefusal transactionId={t.id} />
                  {/* Offered under the picker, never applied: confirming is
                      the tap, and picking anything else declines it. Its own
                      LINE, so its reason wraps within the column instead of
                      widening a table that already scrolls on a phone. */}
                  {(() => {
                    const s = suggestions.get(t.id);
                    return s === undefined ? null : (
                      <div className="mt-1 max-w-[220px] md:max-w-none">
                        <P2PSuggestion
                          transactionId={t.id}
                          categoryId={s.categoryId}
                          categoryName={s.categoryName}
                          reason={s.reason}
                        />
                      </div>
                    );
                  })()}
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
                    Page {page} is past the end; these filters match {matchCount} rows across{" "}
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
      {/* On a single page too, where it repeats the band above, so the page
          reads the same at one page as at ten. */}
      {visible.length > 0 && (
        <TotalsBand
          foot
          label={`This page, ${firstShown.toLocaleString("en-US")}–${lastShown.toLocaleString("en-US")}`}
          totals={pageTotals}
        />
      )}
      {/* Where you actually are when you finish reading a page. */}
      {!groupMode && pageCount > 1 && (
        <div className="flex items-center border-t border-rule py-3 text-[0.78rem] text-faint">
          <Pager params={params} page={page} pageCount={pageCount} pastEnd={pastEnd} />
        </div>
      )}
      </CategoryPickerProvider>
      </GroupPickerProvider>
      )}
    </div>
  );
}
