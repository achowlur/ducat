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

/**
 * One of the three balance groups. These were rows inside the account table
 * first, which was the mistake: a summary figure in the same table, the same
 * alignment and a fainter grey reads as another account, so "what do I owe"
 * stayed invisible even though the number was on screen. A figure that answers
 * a different question needs to look like it.
 */
function BalanceGroup({
  label,
  value,
  note,
  negative,
}: {
  label: string;
  value: number;
  note?: React.ReactNode;
  negative?: boolean;
}) {
  return (
    <div>
      <div className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-faint">{label}</div>
      <div
        className={`font-money text-[1.25rem] tabular ${negative === true ? "font-semibold text-neg" : ""}`}
      >
        {amount(value)}
      </div>
      {note !== undefined && <div className="mt-0.5 text-[0.72rem] text-faint">{note}</div>}
    </div>
  );
}

interface ReviewItem {
  text: string;
  detail: string;
  href?: string;
  /** Costs money to ignore, rather than merely being worth knowing. */
  urgent?: boolean;
}

export default async function OverviewPage() {
  const data = await getOverviewData();
  const simplefinConfigured = (process.env.SIMPLEFIN_ACCESS_URL ?? "") !== "";
  const simplefin = data.health.find((h) => h.connectorType === "SIMPLEFIN");

  // Derived from fields the page already has — no extra query. Urgent first,
  // and uncategorized rows outrank a stale balance because they silently
  // understate every spending total while a stale balance is merely old.
  const behind = data.accounts.filter((a) => a.stale || a.balanceLagDays >= STALE_DISPLAY_DAYS);
  const reviewItems: ReviewItem[] = [
    ...(data.uncategorizedCount > 0
      ? [
          {
            text: `${data.uncategorizedCount} uncategorized transaction${data.uncategorizedCount === 1 ? "" : "s"}`,
            detail: "spending totals are incomplete until these are cleared",
            href: "/transactions?category=uncategorized&group=1",
            urgent: true,
          },
        ]
      : []),
    ...behind.map((a) => ({
      text: `${a.name} is ${a.balanceLagDays} days behind`,
      detail: a.stale ? "the feed has stopped refreshing this balance" : "balance did not move on the last sync",
      urgent: a.stale,
    })),
    // Code and data upgrade separately, and only one of them tells you. A pack
    // change arrives with `git pull`; the rules stay as they were until someone
    // runs the installer, and a green deploy looks identical either way.
    ...(data.pendingPackRules > 0
      ? [
          {
            text: `${data.pendingPackRules} categorization rule${data.pendingPackRules === 1 ? "" : "s"} not installed`,
            detail: "this app version ships rules your database doesn't have — run npm run upgrade",
          },
        ]
      : []),
  ];

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-1 border-b border-rule py-2 text-[0.78rem] text-faint">
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

      {/* Headline, then the detail, then the groups as a closing total. A
          ledger totals at the FOOT of the column it sums, and the band sitting
          between the headline and the accounts read as an interruption of the
          two things it belongs between. */}
      <section className="pt-5">
        <SectionTitle>Net worth — {data.periodLabel}</SectionTitle>
        {data.netWorth === null ? (
          <p className="text-faint">No insights yet. Run a sync or seed fixture data, then generate insights.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="font-money text-[2.1rem] tabular">{money(data.netWorth.netWorth)}</span>
              {data.netWorth.growthRate !== null && (
                <span
                  className={`font-money whitespace-nowrap text-[0.95rem] font-semibold ${
                    data.netWorth.growthRate >= 0 ? "text-pos" : "text-neg"
                  }`}
                >
                  {data.netWorth.growthRate >= 0 ? "▲" : "▼"} {pct(data.netWorth.growthRate).slice(1)} vs last
                  month
                </span>
              )}
            </div>
            <p className="mt-1 text-[0.75rem] text-faint">
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
      </section>

      <div className="grid grid-cols-1 md:grid-cols-[1.12fr_0.88fr]">
        <section className="py-5 md:pr-7">
          <SectionTitle>Accounts</SectionTitle>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-ink">
                <th className="py-1 text-left text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                  Account
                </th>
                <th className="w-px whitespace-nowrap py-1 pl-3 text-left text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                  As of
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
                    <span className="block leading-tight">{a.name}</span>
                    <span className="text-[0.7rem] text-faint">
                      {a.institution} · {TYPE_LABEL[a.type] ?? a.type}
                    </span>
                  </td>
                  {/* Freshness gets a COLUMN rather than a badge appended to the
                      name. A frozen connection is silent for five days, and the
                      only thing that showed Chase had stopped was a date buried
                      in grey text beside the account name — findable only if you
                      already suspected it. A column is scannable down the page,
                      and it is present whether or not anything is late, so the
                      absence of a warning is itself visible. */}
                  <td className="w-px whitespace-nowrap py-1.5 pl-3 text-[0.72rem] text-faint">
                    {a.stale ? (
                      <span className="rounded-[2px] bg-neg px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.06em] text-paper">
                        {a.balanceLagDays}d behind
                      </span>
                    ) : a.balanceLagDays >= STALE_DISPLAY_DAYS ? (
                      <span className="font-semibold text-chart2">{a.balanceLagDays}d behind</span>
                    ) : (
                      (a.snapshotDate ?? "—")
                    )}
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
            </tbody>
          </table>
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

          {/* The third thing Overview owns, after balances and net worth. It
              used to exist only as a red banner in the header when the count
              was non-zero, which meant the page said NOTHING when everything
              was fine — and "all clear" is indistinguishable from "not checked"
              if it is never stated. So this renders in both states, and the
              quiet one is the point. */}
          <div className="mt-6">
            <SectionTitle>Needs review</SectionTitle>
            {reviewItems.length === 0 ? (
              <p className="text-[0.85rem] text-faint">
                Nothing needs review — every transaction is categorized and every balance is current.
              </p>
            ) : (
              <ul className="grid gap-2">
                {reviewItems.map((item) => (
                  <li key={item.text}>
                    {item.href === undefined ? (
                      <span
                        className={`block border-l-2 py-1 pl-2.5 text-[0.85rem] ${
                          item.urgent ? "border-neg" : "border-rule"
                        }`}
                      >
                        <span className="font-semibold">{item.text}</span>{" "}
                        <span className="text-[0.78rem] text-faint">{item.detail}</span>
                      </span>
                    ) : (
                      <Link
                        href={item.href}
                        className={`block border-l-2 py-1 pl-2.5 text-[0.85rem] hover:bg-chip ${
                          item.urgent ? "border-neg" : "border-rule"
                        }`}
                      >
                        <span className="font-semibold">{item.text}</span>{" "}
                        <span className="text-[0.78rem] text-faint">{item.detail} →</span>
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* Held, invested, owed. The runway hangs off CASH rather than floating
          under the table, because it is a statement about that number and
          nothing else on the page. */}
      <section className="grid grid-cols-2 gap-x-6 gap-y-4 border-t-2 border-ink py-4 sm:grid-cols-3">
        <BalanceGroup
          label="Cash"
          value={data.balances.cash}
          note={
            data.runway === null ? (
              `${data.balances.cashAccounts} account${data.balances.cashAccounts === 1 ? "" : "s"}`
            ) : (
              <span title={`Your last ${data.runway.basisMonths} complete months ran ${money(data.runway.low)} to ${money(data.runway.high)}`}>
                <span className="mr-1.5 whitespace-nowrap rounded-[2px] bg-chip px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.08em] text-acc">
                  Projected
                </span>
                <span className="font-money font-semibold text-ink">{data.runway.months} months</span> at{" "}
                {money(data.runway.monthlySpending)}/mo
              </span>
            )
          }
        />
        <BalanceGroup
          label="Investments"
          value={data.balances.investments}
          note={`${data.accounts.filter((a) => !a.isCash && a.balance >= 0).length} accounts`}
        />
        {data.balances.debtAccounts > 0 && (
          <BalanceGroup
            label="Owed"
            value={data.balances.debt}
            negative
            note={`${data.balances.debtAccounts} card${data.balances.debtAccounts === 1 ? "" : "s"}`}
          />
        )}
      </section>
    </>
  );
}