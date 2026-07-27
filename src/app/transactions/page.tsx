import Link from "next/link";
import type { Prisma } from "../../generated/prisma/client";
import { CategoryCell } from "../../components/CategoryCell";
import { GroupedReview, type PayeeGroupView } from "../../components/GroupedReview";
import { ReimburseControl } from "../../components/ReimburseControl";
import { prisma } from "../../lib/prisma";
import { periodEndExclusive, periodStart } from "../../lib/insights/periods";
import { suggestReimbursements } from "../../lib/insights/suggestReimbursements";
import { groupByPayee } from "../../lib/sync/grouping";
import { P2P_PATTERN } from "../../lib/sync/rulePack";
import { amount, isoDate, money, monthLabel, titleCase } from "../../lib/ui/format";
import { periodKey } from "../../lib/insights/periods";

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
  group?: string;
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

/**
 * Expenses nobody splits with the friend who Venmo'd them. Without this the
 * reimbursement ranker will happily offer "1/6 of your $6,300.49 tax payment",
 * because the arithmetic works. Uncategorized outflows stay splittable — a
 * shared dinner often hasn't been categorized yet.
 */
const UNSPLITTABLE = new Set([
  "Rent & Housing",
  "Taxes",
  "Fees & Charges",
  "Utilities",
  "Subscriptions",
  "Health",
  "Cash & ATM",
]);

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
 */
const COLUMNS = [
  { label: "Date", className: "text-left" },
  { label: "Merchant / description", className: "text-left" },
  { label: "Account", className: "hidden text-left md:table-cell" },
  { label: "Category", className: "text-left" },
  { label: "Flow", className: "hidden text-left md:table-cell" },
  { label: "Amount", className: "text-right" },
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
  if (params.category === "uncategorized") {
    where.categoryId = null;
    // Transfers legitimately carry no category — they'd drown the queue.
    // An explicit flow=TRANSFER filter still shows them.
    if (params.flow === undefined || params.flow === "") where.flow = { not: "TRANSFER" };
  } else if (params.category !== undefined && params.category !== "") where.categoryId = params.category;
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

  // Review mode narrows in SQL as far as Prisma can, then finishes in JS: the
  // P2P test is a regex across two columns, which Prisma cannot express. Its
  // candidate set is small by construction, so it is fetched WHOLE and paged in
  // JS — paging in SQL and filtering afterwards gives uneven pages.
  const reviewMode = params.review === "1";
  const listWhere: Prisma.TransactionWhereInput = reviewMode
    ? { ...where, categoryId: null, reimbursesId: null, flow: { not: "TRANSFER" } }
    : where;

  const [rows, total, categories, accounts, dateRange, reviewPool] = await Promise.all([
    prisma.transaction.findMany({
      where: listWhere,
      include: { category: true, account: true, reimburses: true },
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
  ]);

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
  const inflowDates = rows.filter((t) => t.flow === "INFLOW").map((t) => t.date.getTime());
  const DAY_MS = 86_400_000;
  const WINDOW_DAYS = 45;
  const candidatePool =
    inflowDates.length === 0
      ? []
      : await prisma.transaction.findMany({
          where: {
            flow: "OUTFLOW",
            date: {
              gte: new Date(Math.min(...inflowDates) - WINDOW_DAYS * DAY_MS),
              lte: new Date(Math.max(...inflowDates) + 3 * DAY_MS),
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
          orderBy: { date: "desc" },
          take: 2000,
        });
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const poolCategory = (categoryId: string | null): string | null =>
    categoryId === null ? null : (categoryNameById.get(categoryId) ?? null);
  const poolById = new Map(candidatePool.map((o) => [o.id, o]));
  // Identical for every inflow, so it is built once rather than per row.
  const rankable = candidatePool.map((o) => ({
    id: o.id,
    amount: Number(o.amount),
    date: o.date,
    splittable: !UNSPLITTABLE.has(poolCategory(o.categoryId) ?? ""),
  }));
  const candidatesFor = (inflow: { date: Date; amount: unknown }) =>
    suggestReimbursements({ amount: Number(inflow.amount), date: inflow.date }, rankable, {
      windowDays: WINDOW_DAYS,
    }).flatMap((s) => {
      const o = poolById.get(s.id);
      if (o === undefined) return [];
      return [{
        id: o.id,
        label: titleCase(o.normalizedMerchant !== "" ? o.normalizedMerchant : o.description.toLowerCase()),
        date: isoDate(o.date),
        amount: Math.abs(Number(o.amount)),
        category: poolCategory(o.categoryId),
        reason: s.reason,
        strong: s.strong,
      }];
    });

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

  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name, isIncome: c.isIncome }));

  // Grouped review: one decision per payee across the ENTIRE uncategorized
  // backlog (not just the visible page), highest-leverage payee first. A few
  // hundred transactions are typically only a few dozen payees.
  const groupMode = params.group === "1";
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
  const olderPeriod =
    selectedIdx >= 0
      ? (monthOptions[selectedIdx + 1] ?? null)
      : total > visible.length && visible.length > 0
        ? periodKey(visible[visible.length - 1].date, "MONTH")
        : null;
  const newerPeriod = selectedIdx > 0 ? monthOptions[selectedIdx - 1] : null;

  return (
    <div className="py-5">
      <form className="flex flex-wrap items-end gap-3 border-b border-ink pb-3" action="/transactions" method="get">
        {/* The filters DO apply to the grouped query, but a GET form only
            submits its own fields — without this, "review just June" dropped
            you out of the queue and into the flat list. */}
        {groupMode && <input type="hidden" name="group" value="1" />}
        <label className="grid gap-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-faint">
          Period
          <select
            name="period"
            defaultValue={params.period ?? ""}
            className="rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink"
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
          <select name="category" defaultValue={params.category ?? ""} className="rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink">
            <option value="">All</option>
            <option value="uncategorized">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-faint">
          Account
          <select name="account" defaultValue={params.account ?? ""} className="max-w-[160px] rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink">
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
          <select name="flow" defaultValue={params.flow ?? ""} className="rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink">
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
            className="min-w-40 rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink"
          />
        </label>
        <button className="rounded-[2px] border border-ink px-3 py-1 text-[0.78rem] uppercase tracking-[0.08em] hover:bg-chip">
          Filter
        </button>
        <Link
          href={groupMode ? "/transactions?group=1" : "/transactions"}
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
              : `${firstShown}–${lastShown} of ${matchCount}`}
        </span>
        {groupMode ? (
          <Link href={buildHref(params, { group: undefined, page: undefined })} className="font-semibold text-acc hover:underline">
            ← transaction list
          </Link>
        ) : (
          // A bordered control, not body text: this was styled identically to
          // "← all transactions" while being the highest-leverage thing on the
          // screen — Overview's red pill sold it better than its own page did.
          <Link
            href={buildHref(params, { group: "1", category: "uncategorized", review: undefined, page: undefined })}
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
              <Link
                href={buildHref(params, { page: page === 2 ? undefined : String(page - 1) })}
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

      {groupMode ? (
        <GroupedReview groups={groups} categories={categoryOptions} />
      ) : (
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
                  {titleCase(t.normalizedMerchant !== "" ? t.normalizedMerchant : t.description.toLowerCase())}
                  {review && (
                    <span className="ml-2 rounded-[2px] bg-neg px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.05em] text-paper">
                      review
                    </span>
                  )}
                  <span className={`block truncate text-[0.68rem] md:hidden ${FLOW_BADGE[t.flow]}`}>
                    {t.account.name} · {t.flow.toLowerCase()}
                  </span>
                </td>
                <td className="hidden py-1.5 pr-3 text-[0.75rem] text-faint md:table-cell">{t.account.name}</td>
                <td className="py-1.5 pr-3">
                  {t.flow === "TRANSFER" ? (
                    <span className="text-[0.75rem] text-faint" title="Transfers are excluded from spending analytics and carry no category">
                      transfer
                    </span>
                  ) : t.flow === "INFLOW" && t.reimburses !== null ? (
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
                      candidates={[]}
                    />
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <CategoryCell
                        transactionId={t.id}
                        merchant={t.normalizedMerchant}
                        categoryId={t.categoryId}
                        categorySource={t.categorySource}
                        categories={categoryOptions}
                      />
                      {t.flow === "INFLOW" && (
                        <ReimburseControl inflowId={t.id} linked={null} candidates={candidatesFor(t)} />
                      )}
                    </span>
                  )}
                </td>
                <td className={`hidden py-1.5 pr-3 text-[0.68rem] uppercase tracking-[0.06em] md:table-cell ${FLOW_BADGE[t.flow]}`}>
                  {t.flow.toLowerCase()}
                </td>
                <td
                  className={`py-1.5 text-right font-money text-[0.85rem] tabular ${
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
                No transactions match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
      )}
    </div>
  );
}
