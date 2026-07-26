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
import { amount, isoDate, money, titleCase } from "../../lib/ui/format";
import { monthLabel } from "../../lib/ui/trends";
import { periodKey } from "../../lib/insights/periods";

export const dynamic = "force-dynamic";

const LIMIT = 300;

interface Params {
  period?: string;
  category?: string; // category id | "uncategorized"
  account?: string;
  flow?: string;
  q?: string;
  review?: string;
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

  const [rows, total, categories, accounts, dateRange] = await Promise.all([
    prisma.transaction.findMany({
      where,
      include: { category: true, account: true, reimburses: true },
      orderBy: { date: "desc" },
      take: LIMIT * 2, // review filtering happens in JS; fetch headroom
    }),
    prisma.transaction.count({ where }),
    prisma.category.findMany({ orderBy: { name: "asc" } }),
    prisma.account.findMany({ orderBy: { name: "asc" } }),
    prisma.transaction.aggregate({ _min: { date: true }, _max: { date: true } }),
  ]);

  // Month options for the period select: every month with data, newest first.
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
          include: { category: true },
          orderBy: { date: "desc" },
          take: 2000,
        });
  const poolById = new Map(candidatePool.map((o) => [o.id, o]));
  const candidatesFor = (inflow: { date: Date; amount: unknown }) =>
    suggestReimbursements(
      { amount: Number(inflow.amount), date: inflow.date },
      candidatePool.map((o) => ({
        id: o.id,
        amount: Number(o.amount),
        date: o.date,
        splittable: !UNSPLITTABLE.has(o.category?.name ?? ""),
      })),
      { windowDays: WINDOW_DAYS },
    ).flatMap((s) => {
      const o = poolById.get(s.id);
      if (o === undefined) return [];
      return [{
        id: o.id,
        label: titleCase(o.normalizedMerchant !== "" ? o.normalizedMerchant : o.description.toLowerCase()),
        date: isoDate(o.date),
        amount: Math.abs(Number(o.amount)),
        category: o.category?.name ?? null,
        reason: s.reason,
        strong: s.strong,
      }];
    });

  const needsReview = (t: { normalizedMerchant: string; description: string; categoryId: string | null; reimbursesId: string | null }) =>
    t.categoryId === null &&
    t.reimbursesId === null && // linked to its expense = resolved
    (P2P_PATTERN.test(t.normalizedMerchant) || P2P_PATTERN.test(t.description));
  const reviewCount = rows.filter(needsReview).length;
  const visible = (params.review === "1" ? rows.filter(needsReview) : rows).slice(0, LIMIT);

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

  // Older history had no navigable path at all: the list stops at LIMIT with
  // no pagination, and nothing hinted that the period filter was the way back
  // — 1861 of 2,638 rows were simply unreachable. Stepping by month reuses the
  // filter plumbing, and monthOptions only contains months that have data, so
  // a link never lands on an empty page.
  const selectedIdx = params.period === undefined ? -1 : monthOptions.indexOf(params.period);
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
            : `${total} matching${total > visible.length ? ` · showing ${visible.length}` : ""}`}
        </span>
        {groupMode ? (
          <Link href={buildHref(params, { group: undefined })} className="font-semibold text-acc hover:underline">
            ← transaction list
          </Link>
        ) : (
          <Link
            href={buildHref(params, { group: "1", category: "uncategorized", review: undefined })}
            className="font-semibold text-acc hover:underline"
            title="Group the uncategorized backlog by payee — one decision categorizes every occurrence and future ones too"
          >
            group by payee — categorize in bulk
          </Link>
        )}
        {!groupMode && olderPeriod !== null && (
          <Link
            href={buildHref(params, { period: olderPeriod })}
            className="font-semibold text-acc hover:underline"
            title={`Show ${monthLabel(olderPeriod)} — the list stops at ${LIMIT} rows, so the period filter is how you reach older history`}
          >
            ← older ({monthLabel(olderPeriod)})
          </Link>
        )}
        {!groupMode && newerPeriod !== null && (
          <Link href={buildHref(params, { period: newerPeriod })} className="font-semibold text-acc hover:underline">
            newer ({monthLabel(newerPeriod)}) →
          </Link>
        )}
        {!groupMode &&
          (params.review === "1" ? (
          <Link href={buildHref(params, { review: undefined })} className="font-semibold text-acc hover:underline">
            ← all transactions
          </Link>
        ) : (
            reviewCount > 0 && (
              <Link href={buildHref(params, { review: "1" })} className="font-semibold text-neg hover:underline">
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
