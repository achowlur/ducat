import Link from "next/link";
import { MiniDonut } from "../components/MiniDonut";
import { SyncNowButton } from "../components/SyncNowButton";
import { amount, dateTime, money, pct } from "../lib/ui/format";
import { getOverviewData, STALE_DISPLAY_DAYS } from "../lib/ui/overview";
import { transactionsHref } from "../lib/ui/categoryFilter";

export const dynamic = "force-dynamic";
// Server Actions run under their page's budget, and "Sync now" calls the same
// runSync as the cron — which declares 60 while this page would otherwise take
// the platform default. In cloud mode every read is an HTTP round trip to Turso,
// so the two need the same ceiling or the button times out where the cron
// doesn't. 60 is also Vercel's Hobby maximum.
export const maxDuration = 60;

const TYPE_LABEL: Record<string, string> = {
  DEPOSITORY: "Depository",
  INVESTMENT: "Investment",
  CREDIT: "Credit",
  LOAN: "Loan",
};

const DONUT_COLORS = ["bg-chart1", "bg-chart2", "bg-pie3", "bg-pie4"];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2.5 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
      {children}
    </h3>
  );
}

/** A grouping row in the balance table: quieter than the net-worth total. */
function SubTotal({ label, note, value }: { label: string; note?: string; value: number }) {
  return (
    <tr className="border-t border-rule">
      <td className="py-1.5 text-[0.78rem] text-faint">
        {label} {note !== undefined && <span className="text-[0.7rem]">{note}</span>}
      </td>
      <td />
      <td
        className={`w-px whitespace-nowrap py-1.5 pl-3 text-right font-money text-[0.78rem] tabular ${
          value < 0 ? "font-semibold text-neg" : "text-faint"
        }`}
      >
        {amount(value)}
      </td>
    </tr>
  );
}

export default async function OverviewPage() {
  const data = await getOverviewData();
  const simplefinConfigured = (process.env.SIMPLEFIN_ACCESS_URL ?? "") !== "";
  const simplefin = data.health.find((h) => h.connectorType === "SIMPLEFIN");

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-1 border-b border-rule py-2 text-[0.78rem] text-faint">
        {data.uncategorizedCount > 0 && (
          <Link
            href="/transactions?category=uncategorized&group=1"
            className="rounded-[2px] bg-neg px-2 py-1 font-semibold text-paper hover:opacity-90"
            title="Spending analytics are incomplete until every transaction has a category — click to clear them in bulk, grouped by payee"
          >
            {data.uncategorizedCount} uncategorized transaction{data.uncategorizedCount === 1 ? "" : "s"} — fix
            first ↗
          </Link>
        )}
        {simplefin !== undefined && (
          <span>
            <span
              className={`mr-1.5 inline-block h-2 w-2 rounded-full ${
                simplefin.status === "OK" ? "bg-pos" : simplefin.status === "ERROR" ? "bg-neg" : "bg-chart2"
              }`}
            />
            {/* Casing left alone: the reason is a whole sentence, and
                lowercasing it mid-line mangled what /providers renders
                correctly. "Standing risks" is a static array length dressed as
                live status — it lives on /providers, where it is explained. */}
            {simplefin.trustCard.displayName} — {simplefin.reasons[0]} · {simplefin.accountCount}{" "}
            account{simplefin.accountCount === 1 ? "" : "s"}
          </span>
        )}
        {(data.lastSyncAt !== null || simplefinConfigured) && (
          <span className="ml-auto flex items-center gap-3 font-money">
            {data.lastSyncAt !== null && (
              <span>synced {dateTime(data.lastSyncAt)}</span>
            )}
            {simplefinConfigured && <SyncNowButton />}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1.12fr_0.88fr]">
        <section className="py-5 md:pr-7">
          <SectionTitle>Net worth — {data.periodLabel}</SectionTitle>
          {data.netWorth === null ? (
            <p className="text-faint">No insights yet. Run a sync or seed fixture data, then generate insights.</p>
          ) : (
            <>
              <div className="flex items-baseline gap-4">
                <span className="font-money text-[2.1rem] tabular">{money(data.netWorth.netWorth)}</span>
                {data.netWorth.growthRate !== null && (
                  <span
                    className={`font-money text-[0.95rem] font-semibold ${
                      data.netWorth.growthRate >= 0 ? "text-pos" : "text-neg"
                    }`}
                  >
                    {data.netWorth.growthRate >= 0 ? "▲" : "▼"} {pct(data.netWorth.growthRate).slice(1)} vs last
                    month
                  </span>
                )}
              </div>
              <p className="mb-4 mt-1 text-[0.75rem] text-faint">
                {data.netWorth.marketGains !== null && data.netWorth.marketGains !== 0 && (
                  <>
                    <span
                      className={`font-money font-semibold ${data.netWorth.marketGains > 0 ? "text-pos" : "text-neg"}`}
                    >
                      {money(data.netWorth.marketGains)}
                    </span>{" "}
                    of this month&apos;s change is investment market movement (not income).{" "}
                  </>
                )}
                {data.estimatedCount > 0 && (
                  <>
                    {data.estimatedCount} of {data.accounts.length} balances reconstructed from transactions
                    (no snapshot).
                  </>
                )}
              </p>
            </>
          )}

          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-ink">
                <th className="py-1 text-left text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                  Account
                </th>
                <th className="w-px whitespace-nowrap py-1 pl-3 text-left text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                  Type
                </th>
                <th className="w-px whitespace-nowrap py-1 pl-3 text-right text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                  Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.id} className="border-b border-rule">
                  <td className="py-1.5 text-[0.85rem]">
                    {a.name}{" "}
                    <span className="text-[0.72rem] text-faint">
                      {a.institution}
                      {a.snapshotBacked ? ` · snapshot ${a.snapshotDate}` : ""}
                    </span>
                    {/* A frozen connection is silent for five days, and the
                        only thing that showed Chase had stopped was this date
                        in grey. The age is printed once it is old enough to
                        mean anything; the chip waits for health's tuned bar. */}
                    {a.stale ? (
                      <span className="ml-2 whitespace-nowrap rounded-[2px] bg-neg px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.06em] text-paper">
                        {a.balanceLagDays}d behind
                      </span>
                    ) : (
                      a.balanceLagDays >= STALE_DISPLAY_DAYS && (
                        <span className="ml-2 whitespace-nowrap text-[0.66rem] uppercase tracking-[0.06em] text-chart2">
                          {a.balanceLagDays}d behind
                        </span>
                      )
                    )}
                  </td>
                  {/* Six-figure balances squeeze the flexible columns; pin the
                      numeric and type columns to their content and let the
                      account name absorb the remaining width instead. */}
                  <td className="w-px whitespace-nowrap py-1.5 pl-3 text-[0.72rem] text-faint">
                    {TYPE_LABEL[a.type] ?? a.type}
                  </td>
                  <td
                    className={`w-px whitespace-nowrap py-1.5 pl-3 text-right font-money text-[0.85rem] tabular ${
                      a.balance < 0 ? "font-semibold text-neg" : ""
                    }`}
                  >
                    {amount(a.balance)}
                  </td>
                </tr>
              ))}
              {/* Held / invested / owed, so the reader is not adding a column
                  of signed numbers by eye to answer "what do I owe". Grouped
                  from rows already fetched — no extra query. */}
              <SubTotal label="Cash" note={`${data.balances.cashAccounts} accounts`} value={data.balances.cash} />
              <SubTotal label="Investments" value={data.balances.investments} />
              {data.balances.debtAccounts > 0 && (
                <SubTotal
                  label="Owed"
                  note={`${data.balances.debtAccounts} account${data.balances.debtAccounts === 1 ? "" : "s"}`}
                  value={data.balances.debt}
                />
              )}
              {data.netWorth !== null && (
                <tr>
                  <td className="border-t-2 border-ink py-1.5 font-semibold">Net worth</td>
                  <td className="border-t-2 border-ink" />
                  <td className="w-px whitespace-nowrap border-t-2 border-ink py-1.5 pl-3 text-right font-money text-[0.85rem] font-semibold tabular">
                    {amount(data.netWorth.netWorth)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* The one forward-looking number on this page, so it is chipped and
              worded like one. The SPREAD is printed beside it deliberately: the
              mean is drawn from months running {low}–{high}, and a single
              figure would read as steadier than the underlying months are. */}
          {data.runway !== null && (
            <p className="mt-3 text-[0.78rem] text-faint">
              <span className="mr-2 whitespace-nowrap rounded-[2px] bg-chip px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-acc">
                Projected
              </span>
              <span className="font-money text-[0.95rem] font-semibold tabular text-ink">
                {data.runway.months}
              </span>{" "}
              months of cash at {money(data.runway.monthlySpending)}/month — the average of your
              last {data.runway.basisMonths} complete months, which ran {money(data.runway.low)} to{" "}
              {money(data.runway.high)}.
            </p>
          )}
        </section>

        <section className="border-rule py-5 md:border-l md:pl-7">
          {data.donut !== null && (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <SectionTitle>Spending — {data.periodLabel.split(" ")[0]}</SectionTitle>
                {/* The donut answers "on what?"; Trends answers "compared to
                    when?" — so the ring drills into transactions and the
                    heading goes to the fuller breakdown. */}
                <Link
                  href={`/trends?period=${data.period}`}
                  className="pb-2 text-[0.72rem] uppercase tracking-[0.08em] text-acc hover:underline"
                >
                  full breakdown →
                </Link>
              </div>
              {/* Stacked below md: sharing a row with the legend squeezed the
                  donut to 76px, with a 5px total in the hole. */}
              <div className="flex flex-col items-start gap-4 md:flex-row md:items-center">
                {/* Bigger and centred on a phone, where it is the only graphic
                    in a 327px column — at 170px its ring is barely 108px wide
                    (the viewBox carries ~31px of padding a side) and it read as
                    stranded against a void. The legend below stays flush left
                    with the section title. `self-center` is safe at every width:
                    on the desktop row the cross axis is vertical, which is what
                    the wrapper's md:items-center already does. */}
                <MiniDonut
                  slices={data.donut.slices}
                  centerTop={money(data.donut.total)}
                  centerBottom="this month"
                  className="w-[230px] self-center md:w-[170px]"
                  hrefFor={(s) => transactionsHref(s.categoryIds, data.period)}
                />
                <div className="grid gap-1.5 font-money text-[0.78rem] tabular">
                  {data.donut.slices.map((s, i) => (
                    <Link
                      key={s.label}
                      href={transactionsHref(s.categoryIds, data.period)}
                      className="grid grid-cols-[11px_96px_72px_38px] items-center gap-1.5 rounded-[2px] hover:bg-chip"
                      title={
                        s.categoryIds.length > 1
                          ? `View the ${s.categoryIds.length} categories in Other`
                          : `View ${s.label} transactions`
                      }
                    >
                      <i className={`h-[11px] w-[11px] rounded-[2px] ${DONUT_COLORS[i % DONUT_COLORS.length]}`} />
                      <span className="font-ledger">{s.label}</span>
                      <span className="text-right">{amount(s.value)}</span>
                      <span className="text-right text-faint">{Math.round(s.share * 100)}%</span>
                    </Link>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
