import Link from "next/link";
import { MiniDonut } from "../components/MiniDonut";
import { SyncNowButton } from "../components/SyncNowButton";
import { amount, money, pct } from "../lib/ui/format";
import { getOverviewData, type Signal } from "../lib/ui/overview";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  DEPOSITORY: "Depository",
  INVESTMENT: "Investment",
  CREDIT: "Credit",
  LOAN: "Loan",
};

const CHIP_CLASS: Record<Signal["tone"], string> = {
  neg: "bg-neg text-paper",
  pos: "bg-pos text-paper",
  neutral: "bg-chip text-acc",
};

const DONUT_COLORS = ["bg-chart1", "bg-chart2", "bg-pie3", "bg-pie4"];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2.5 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
      {children}
    </h3>
  );
}

export default async function OverviewPage() {
  const data = await getOverviewData();
  const simplefinConfigured = (process.env.SIMPLEFIN_ACCESS_URL ?? "") !== "";
  const simplefin = data.health.find((h) => h.connectorType === "SIMPLEFIN");
  const drifted = data.subscriptions.filter((s) => s.priceDrift !== null);
  const nextRenewal = data.subscriptions.find((s) => s.priceDrift === null && s.daysUntilNextPayment <= 45);

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-1 border-b border-rule py-2 text-[0.78rem] text-faint">
        {data.uncategorizedCount > 0 && (
          <Link
            href="/transactions?category=uncategorized"
            className="rounded-[2px] bg-neg px-2 py-1 font-semibold text-paper hover:opacity-90"
            title="Spending analytics are incomplete until every transaction has a category — click to fix"
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
            {simplefin.trustCard.displayName} — {simplefin.reasons[0].toLowerCase()} · {simplefin.accountCount}{" "}
            accounts · {simplefin.trustCard.residualRisks.length} standing risks
          </span>
        )}
        {drifted.map((s) => (
          <span key={s.id} className="font-semibold text-neg">
            {s.name} charged {money(s.lastCharge?.amount ?? 0)} vs {money(s.expectedAmount)} expected (
            {pct(s.priceDrift?.deltaPct ?? 0)})
          </span>
        ))}
        {nextRenewal !== undefined && (
          <span>
            {nextRenewal.name} renews in {nextRenewal.daysUntilNextPayment} days
          </span>
        )}
        {(data.lastSyncAt !== null || simplefinConfigured) && (
          <span className="ml-auto flex items-center gap-3 font-money">
            {data.lastSyncAt !== null && (
              <span>synced {data.lastSyncAt.toISOString().slice(0, 16).replace("T", " ")}</span>
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
                <th className="py-1 text-left text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                  Type
                </th>
                <th className="py-1 text-right text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
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
                  </td>
                  <td className="py-1.5 text-[0.72rem] text-faint">{TYPE_LABEL[a.type] ?? a.type}</td>
                  <td
                    className={`py-1.5 text-right font-money text-[0.85rem] tabular ${
                      a.balance < 0 ? "font-semibold text-neg" : ""
                    }`}
                  >
                    {amount(a.balance)}
                  </td>
                </tr>
              ))}
              {data.netWorth !== null && (
                <tr>
                  <td className="border-t-2 border-ink py-1.5 font-semibold">Net worth</td>
                  <td className="border-t-2 border-ink" />
                  <td className="border-t-2 border-ink py-1.5 text-right font-money text-[0.85rem] font-semibold tabular">
                    {amount(data.netWorth.netWorth)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="mt-6">
            <SectionTitle>Tracked subscriptions</SectionTitle>
            {data.subscriptions.length === 0 && <p className="text-[0.85rem] text-faint">None registered.</p>}
            {data.subscriptions.map((s) => (
              <div key={s.id} className="flex justify-between border-b border-rule py-1.5 text-[0.85rem] last:border-b-0">
                <span>
                  {s.name} <span className="text-[0.72rem] text-faint">{s.cadence.toLowerCase()}</span>
                </span>
                {s.priceDrift === null ? (
                  <span className="font-money tabular">
                    {money(s.expectedAmount)} · renews {s.nextPaymentDate.toISOString().slice(5, 10)} (
                    {s.daysUntilNextPayment}d)
                  </span>
                ) : (
                  <span className="font-money font-semibold tabular text-neg">
                    {money(s.lastCharge?.amount ?? 0)} charged · {money(s.expectedAmount)} expected
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="border-rule py-5 md:border-l md:pl-7">
          {data.donut !== null && (
            <>
              <SectionTitle>Spending — {data.periodLabel.split(" ")[0]}</SectionTitle>
              <div className="mb-5 flex items-center gap-4">
                <MiniDonut
                  slices={data.donut.slices}
                  centerTop={money(data.donut.total)}
                  centerBottom="this month"
                />
                <div className="grid gap-1.5 font-money text-[0.78rem] tabular">
                  {data.donut.slices.map((s, i) => (
                    <div key={s.label} className="grid grid-cols-[11px_96px_72px_38px] items-center gap-1.5">
                      <i className={`h-[11px] w-[11px] rounded-[2px] ${DONUT_COLORS[i % DONUT_COLORS.length]}`} />
                      <span className="font-ledger">{s.label}</span>
                      <span className="text-right">{amount(s.value)}</span>
                      <span className="text-right text-faint">{Math.round(s.share * 100)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          <SectionTitle>This month&apos;s signals</SectionTitle>
          {data.signals.length === 0 && <p className="text-[0.85rem] text-faint">Nothing unusual.</p>}
          {data.signals.map((s, i) => (
            <div key={i} className="flex gap-2.5 border-b border-rule py-2 text-[0.85rem] last:border-b-0">
              <span
                className={`mt-0.5 self-start whitespace-nowrap rounded-[2px] px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] ${CHIP_CLASS[s.tone]}`}
              >
                {s.chip}
              </span>
              <span>{s.text}</span>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
