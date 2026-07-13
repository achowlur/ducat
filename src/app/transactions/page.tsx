import Link from "next/link";
import type { Prisma } from "../../generated/prisma/client";
import { CategoryCell } from "../../components/CategoryCell";
import { ReimburseControl } from "../../components/ReimburseControl";
import { prisma } from "../../lib/prisma";
import { periodEndExclusive, periodStart } from "../../lib/insights/periods";
import { P2P_PATTERN } from "../../lib/sync/rulePack";
import { amount, isoDate, titleCase } from "../../lib/ui/format";
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

  // Reimbursement candidates: outflows within 30 days before each visible
  // inflow, big enough to plausibly be the fronted expense.
  const inflowDates = rows.filter((t) => t.flow === "INFLOW").map((t) => t.date.getTime());
  const DAY_MS = 86_400_000;
  const candidatePool =
    inflowDates.length === 0
      ? []
      : await prisma.transaction.findMany({
          where: {
            flow: "OUTFLOW",
            date: {
              gte: new Date(Math.min(...inflowDates) - 30 * DAY_MS),
              lte: new Date(Math.max(...inflowDates)),
            },
          },
          include: { category: true },
          orderBy: { date: "desc" },
          take: 500,
        });
  const candidatesFor = (inflow: { date: Date; amount: unknown }) =>
    candidatePool
      .filter((o) => {
        const gap = inflow.date.getTime() - o.date.getTime();
        return gap >= 0 && gap <= 30 * DAY_MS && Math.abs(Number(o.amount)) >= Number(inflow.amount) * 0.999;
      })
      .sort((a, b) => (inflow.date.getTime() - a.date.getTime()) - (inflow.date.getTime() - b.date.getTime()))
      .slice(0, 5)
      .map((o) => ({
        id: o.id,
        label: titleCase(o.normalizedMerchant !== "" ? o.normalizedMerchant : o.description.toLowerCase()),
        date: isoDate(o.date),
        amount: Math.abs(Number(o.amount)),
        category: o.category?.name ?? null,
      }));

  const needsReview = (t: { normalizedMerchant: string; description: string; categoryId: string | null; reimbursesId: string | null }) =>
    t.categoryId === null &&
    t.reimbursesId === null && // linked to its expense = resolved
    (P2P_PATTERN.test(t.normalizedMerchant) || P2P_PATTERN.test(t.description));
  const reviewCount = rows.filter(needsReview).length;
  const visible = (params.review === "1" ? rows.filter(needsReview) : rows).slice(0, LIMIT);

  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name, isIncome: c.isIncome }));

  return (
    <div className="py-5">
      <form className="flex flex-wrap items-end gap-3 border-b border-ink pb-3" action="/transactions" method="get">
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
            placeholder="merchant or description"
            className="min-w-40 rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink"
          />
        </label>
        <button className="rounded-[2px] border border-ink px-3 py-1 text-[0.78rem] uppercase tracking-[0.08em] hover:bg-chip">
          Filter
        </button>
        <Link
          href="/transactions"
          className="pb-1.5 text-[0.75rem] uppercase tracking-[0.08em] text-faint hover:text-ink"
        >
          Clear
        </Link>
      </form>

      <div className="flex items-center gap-5 py-2 text-[0.78rem] text-faint">
        <span className="font-money">
          {total} matching{total > visible.length ? ` · showing ${visible.length}` : ""}
        </span>
        {params.review === "1" ? (
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
        )}
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-ink">
            {["Date", "Merchant / description", "Account", "Category", "Flow", "Amount"].map((h, i) => (
              <th
                key={h}
                className={`py-1 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint ${i === 5 ? "text-right" : "text-left"}`}
              >
                {h}
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
                <td className="max-w-[280px] truncate py-1.5 pr-3 text-[0.85rem]" title={t.description}>
                  {titleCase(t.normalizedMerchant !== "" ? t.normalizedMerchant : t.description.toLowerCase())}
                  {review && (
                    <span className="ml-2 rounded-[2px] bg-neg px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.05em] text-paper">
                      review
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-[0.75rem] text-faint">{t.account.name}</td>
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
                <td className={`py-1.5 pr-3 text-[0.68rem] uppercase tracking-[0.06em] ${FLOW_BADGE[t.flow]}`}>
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
  );
}
