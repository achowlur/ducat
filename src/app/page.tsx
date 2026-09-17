import Link from "next/link";
import { MiniDonut } from "../components/MiniDonut";
import { sliceSwatch } from "../lib/ui/donutColors";
import { wholePercents } from "../lib/ui/spendingBreakdown";
import { SyncNowButton } from "../components/SyncNowButton";
import { amount, dateTime, money, pct } from "../lib/ui/format";
import { getOverviewData, STALE_DISPLAY_DAYS } from "../lib/ui/overview";
import { STATUS_DOT } from "../lib/ui/providers";
import { PageTitle, SectionTitle } from "../components/ui/headings";
import { transactionsHref } from "../lib/ui/categoryFilter";
import { withDatabaseNotice } from "../components/DatabaseNotice";

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
  return withDatabaseNotice(renderOverview);
}

async function renderOverview() {
  const data = await getOverviewData();
  const simplefinConfigured = (process.env.SIMPLEFIN_ACCESS_URL ?? "") !== "";
  const simplefin = data.health.find((h) => h.connectorType === "SIMPLEFIN");
  // This instant sits in the strip that NAMES SimpleFIN, so it has to be
  // SimpleFIN's own. Read unscoped it was the newest successful sync of any
  // connector, so the moment a CSV import was the most recent run its
  // timestamp printed directly after the words "SimpleFIN Bridge" and read as
  // the feed's freshness. With no SimpleFIN entry nothing is being labelled,
  // so the app-wide instant is the honest one; with an entry that has never
  // synced there is no instant to print, and the line is correctly absent.
  const stripSyncAt = simplefin === undefined ? data.lastSyncAt : simplefin.lastSuccessfulSyncAt;
  const ctx = data.monthContext;
  const hasMarketLine = ctx !== null && ctx.marketGains !== null && ctx.marketGains !== 0;
  /** "August", for the spending block's caption. */
  const currentMonthName = data.currentPeriodLabel.split(" ")[0];

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
            // `payees=1` — the bulk queue's param was `group=1` until the
            // trip filter claimed `?group=` for labels.
            href: "/transactions?category=uncategorized&payees=1",
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
      <PageTitle>Overview</PageTitle>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-1 border-b border-rule py-2 text-[0.78rem] text-faint">
        {simplefin !== undefined && (
          <span>
            <span
              className={`mr-1.5 inline-block h-2 w-2 rounded-full ${
                STATUS_DOT[simplefin.status] ?? STATUS_DOT.UNKNOWN
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
        {(stripSyncAt !== null || simplefinConfigured) && (
          <span className="ml-auto flex items-center gap-3 font-money">
            {stripSyncAt !== null && <span>synced {dateTime(stripSyncAt)}</span>}
            {simplefinConfigured && <SyncNowButton />}
          </span>
        )}
      </div>

      {/* Headline, then the detail, then the groups as a closing total. A
          ledger totals at the FOOT of the column it sums, and the band sitting
          between the headline and the accounts read as an interruption of the
          two things it belongs between. */}
      <section className="pt-5">
        <SectionTitle>Net worth</SectionTitle>
        {data.accounts.length === 0 ? (
          <p className="text-faint">No accounts yet. Run a sync or import a CSV, then generate insights.</p>
        ) : (
          <>
            {/* LIVE: the plain signed sum of the balances below — the sign
                convention's own definition. It carries NO month label, and the
                month-over-month context below carries its own, because the two
                are different instants: a July figure over today's balances
                read as one state and drifted apart all month. */}
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="font-money text-[2.1rem] tabular">{money(data.liveNetWorth)}</span>
            </div>
            {ctx !== null &&
              (ctx.growthRate !== null || hasMarketLine || ctx.estimatedCount > 0) && (
                <p className="mt-1 text-[0.78rem] text-faint">
                  <span className="font-semibold text-ink">{ctx.label}:</span>{" "}
                  {ctx.growthRate !== null && (
                    <span
                      className={`font-money whitespace-nowrap font-semibold ${
                        ctx.growthRate >= 0 ? "text-pos" : "text-neg"
                      }`}
                    >
                      {ctx.growthRate >= 0 ? "▲" : "▼"} {pct(ctx.growthRate).slice(1)}
                    </span>
                  )}
                  {ctx.growthRate !== null && hasMarketLine && " · "}
                  {hasMarketLine && ctx.marketGains !== null && (
                    <>
                      <span
                        className={`font-money font-semibold ${
                          ctx.marketGains > 0 ? "text-pos" : "text-neg"
                        }`}
                      >
                        {money(ctx.marketGains)}
                      </span>{" "}
                      of {ctx.monthName}&apos;s change was investment market movement (not income).{" "}
                    </>
                  )}
                  {ctx.estimatedCount > 0 && (
                    <>
                      {ctx.estimatedCount} of {ctx.monthName}&apos;s balances reconstructed from
                      transactions (no snapshot).
                    </>
                  )}
                </p>
              )}
          </>
        )}
      </section>

      {/* Explicit placement on desktop so NEEDS REVIEW can be a grid child in
          its own right and still sit under SPENDING in the right column. It
          has to be a sibling, not a nested block, to be reorderable at all —
          and on a phone it needs reordering: measured unscrolled at 375px the
          spending block began 1.03 screens down and the review panel 1.18, so
          the first screen of the front page was net worth and six account
          rows, with everything the page says about what needs attention below
          the fold. It hoists ONLY when it has items: the documented shape is
          HEADLINE → DETAIL → TOTAL, and moving a panel that says "all clear"
          above the detail would buy nothing and cost the shape. The quiet
          state stays exactly where it was. */}
      <div className="grid grid-cols-1 md:grid-cols-[1.12fr_0.88fr]">
        <section className="py-5 md:col-start-1 md:row-span-2 md:row-start-1 md:pr-7">
          <SectionTitle>Accounts</SectionTitle>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-ink">
                <th scope="col" className="py-1 text-left text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                  Account
                </th>
                <th scope="col" className="w-px whitespace-nowrap py-1 pl-3 text-left text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                  As of
                </th>
                <th scope="col" className="w-px whitespace-nowrap py-1 pl-3 text-right text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint">
                  Balance
                </th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.id} className="border-b border-rule">
                  <td className="py-1.5 text-[0.85rem]">
                    <span className="block leading-tight">{a.name}</span>
                    {/* The cash override is a Setting, and until now it was
                        disclosed NOWHERE in the UI: a $52,331.01 brokerage
                        balance counted into CASH while its row read
                        "Investment", so the band could not be reconciled
                        against the table under it by any reader. Marked in the
                        subtitle the row already has, at zero new elements —
                        the flag was on the row all along and rendered nothing.
                        Same instinct as the freshness column: state it whether
                        or not it is surprising, so its absence means something
                        too. */}
                    <span className="text-[0.7rem] text-faint">
                      {a.institution} · {TYPE_LABEL[a.type] ?? a.type}
                      {a.isCash && a.type !== "DEPOSITORY" ? " · counts as cash" : ""}
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

        <section className="border-rule py-5 md:col-start-2 md:row-start-1 md:border-l md:pl-7">
          {/* The month being LIVED IN, always — a July donut under a "this
              month" hole label was two instants presented as one state. The
              block renders in the empty state too: "nothing recorded yet" is a
              claim about coverage, not an absence to be hidden, and the prior
              month stays one quiet link away. */}
          <div className="flex items-baseline justify-between gap-3">
            <SectionTitle>Spending — {currentMonthName}</SectionTitle>
            {/* The donut answers "on what?"; Trends answers "compared to
                when?" — so the ring drills into transactions and the
                heading goes to the fuller breakdown. Only when the month has
                a row: /trends silently clamps a period it has no row for,
                and a link that lands somewhere it did not name is worse than
                no link. */}
            {data.spendingTotal !== null && (
              <Link
                href={`/trends?period=${data.currentPeriod}`}
                className="pb-2 text-[0.72rem] uppercase tracking-[0.08em] text-acc hover:underline"
              >
                full breakdown →
              </Link>
            )}
          </div>
          {data.donut !== null ? (
            /* Stacked until xl: the ring names every category at 3% or more
                (up to eight legend rows), and ring plus legend need ~450px side
                by side — the column only has that at xl. Below it the legend
                takes the column's width under the ring instead of squeezing
                it (sharing a row below md once shrank the ring to 76px). */
            <div className="flex flex-col items-start gap-4 xl:flex-row xl:items-center">
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
                className="w-[230px] shrink-0 self-center xl:w-[200px]"
                hrefFor={(s) => transactionsHref(s.categoryIds, data.currentPeriod)}
              />
              {/* Percentages of one whole, rounded together (wholePercents):
                  eight rows rounded one by one can print a legend summing to
                  101%. The name column flexes and truncates, so a long
                  category name costs its own tail, never a figure. */}
              <div className="grid w-full max-w-[380px] gap-1.5 font-money text-[0.78rem] tabular xl:w-auto xl:min-w-0 xl:flex-1">
                {(() => {
                  const pct = wholePercents(data.donut.slices.map((s) => s.share));
                  return data.donut.slices.map((s, i) => (
                    <Link
                      key={s.label}
                      href={transactionsHref(s.categoryIds, data.currentPeriod)}
                      className="grid grid-cols-[11px_minmax(0,1fr)_76px_34px] items-center gap-1.5 rounded-[2px] hover:bg-chip"
                      title={
                        s.isOther
                          ? `View the ${s.categoryIds.length} categories in Other`
                          : `View ${s.label} transactions`
                      }
                    >
                      <i className={`h-[11px] w-[11px] rounded-[2px] ${sliceSwatch(s, i)}`} />
                      <span className="truncate font-ledger">
                        {s.label}
                        {s.isOther && <span className="text-faint"> · {s.categoryIds.length}</span>}
                      </span>
                      <span className="text-right">{amount(s.value)}</span>
                      <span className="text-right text-faint">{pct[i]}%</span>
                    </Link>
                  ));
                })()}
              </div>
            </div>
          ) : data.spendingTotal !== null ? (
            /* A row exists but nothing is drawable — reimbursements outran
                spending. "No spending" would be false; the net figure is the
                same totalSpending every screen prints. */
            <p className="text-[0.85rem] text-faint">
              Reimbursements exceeded spending in {currentMonthName} — net{" "}
              <span className="font-money tabular text-ink">{money(data.spendingTotal)}</span> so far.
            </p>
          ) : (
            /* Nothing recorded YET — a coverage claim, not "nothing needs
                attention": the engine has not looked at a month no sync has
                reached. All clear cannot be told from not checked. */
            <>
              <p className="text-[0.85rem] text-faint">
                Nothing recorded for {currentMonthName} yet — spending appears with the month&apos;s
                first sync.
              </p>
              {data.priorSpending !== null && (
                <p className="mt-1.5 text-[0.85rem]">
                  <Link
                    href={`/trends?period=${data.priorSpending.period}`}
                    // "Quiet" is the documented intent and the COLOUR keeps it
                    // — but every affordance it had was a hover state, which
                    // does not exist on a phone, so on the empty month the one
                    // way out looked exactly like the grey sentence above it.
                    // A permanent underline and a real tap box, at no extra
                    // visual weight.
                    className="tap44 font-money tabular text-faint underline decoration-rule underline-offset-2 hover:text-ink"
                  >
                    {data.priorSpending.monthName}: {money(data.priorSpending.total)} →
                  </Link>
                </p>
              )}
            </>
          )}

        </section>

        {/* The third thing Overview owns, after balances and net worth. It
            used to exist only as a red banner in the header when the count
            was non-zero, which meant the page said NOTHING when everything
            was fine — and "all clear" is indistinguishable from "not checked"
            if it is never stated. So this renders in both states, and the
            quiet one is the point. */}
        <section
          className={`border-rule pb-5 md:col-start-2 md:row-start-2 md:border-l md:pl-7 ${
            reviewItems.length > 0 ? "max-md:order-first max-md:pt-5" : "max-md:mt-6"
          }`}
        >
          <div>
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
              <span>
                <span className="mr-1.5 whitespace-nowrap rounded-[2px] bg-chip px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.08em] text-acc">
                  Projected
                </span>
                <span className="font-money font-semibold text-ink">{data.runway.months} months</span> at{" "}
                {money(data.runway.monthlySpending)}/mo
                {/* The spread the average hides, printed rather than hovered.
                    A projection to one decimal place over months that ran
                    $3,125.52 to $13,746.27 — a 4.4× range — was stating far
                    more confidence than it has, and the only qualification
                    lived in a title attribute no touch device can open. */}
                <span className="block font-money text-[0.68rem] tabular">
                  {data.runway.basisMonths} months ran {money(data.runway.low)}–{money(data.runway.high)}
                </span>
              </span>
            )
          }
        />
        <BalanceGroup
          label="Investments"
          value={data.balances.investments}
          note={`${data.balances.investmentAccounts} account${data.balances.investmentAccounts === 1 ? "" : "s"}`}
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