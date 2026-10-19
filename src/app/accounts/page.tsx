import { Fragment } from "react";
import Link from "next/link";
import { AccountTypeSelect } from "../../components/AccountTypeSelect";
import { Sparkline } from "../../components/Sparkline";
import { amount, dateTime, shortDate } from "../../lib/ui/format";
import { accountsHref } from "../../lib/ui/accountFilter";
import { getAccountsData } from "../../lib/ui/accounts";
import { CHIP, COLUMN_HEADER, PageTitle } from "../../components/ui/headings";
import { StaleAlert } from "../../components/StaleAlert";
import { withDatabaseNotice } from "../../components/DatabaseNotice";

export const dynamic = "force-dynamic";

/**
 * Snapshot history and transaction counts are context, not the reason to open
 * this screen; below md they drop so account, balance and type fit a phone.
 *
 * TYPE now drops with them. It was left in and did not fit: the table needed
 * 363px inside a 327px scroller at 375px, so the row's only action — the link
 * into its transactions — was clipped by 35.6px, more than half of it, with
 * the page body itself not scrolling so nothing hinted the table did. Type is
 * a rare correction made once, on a desktop; the link is why the row is
 * tappable at all. Dropping Type returns 116px and takes the table under the
 * scroller's width at both common phone sizes (375 and 390).
 */
const COLUMNS = [
  { label: "Account", className: "text-left" },
  { label: "Balance", className: "text-right" },
  { label: "History", className: "hidden text-left md:table-cell" },
  { label: "Activity", className: "hidden text-left md:table-cell" },
  { label: "Type", className: "hidden text-left md:table-cell" },
  { label: "", className: "text-left" },
];

export default async function AccountsPage() {
  return withDatabaseNotice(renderAccounts);
}

async function renderAccounts() {
  const data = await getAccountsData();
  const behind = data.groups.reduce((n, g) => n + g.accounts.filter((a) => a.staleByAge).length, 0);

  if (data.groups.length === 0) {
    return (
      <p className="py-10 text-faint">No accounts yet. Run a sync or seed fixture data.</p>
    );
  }

  return (
    <div className="py-5">
      <PageTitle>Accounts</PageTitle>
      {/* LEADS with the figure the page exists for and how fresh it is. The
          clock every "Nd behind" below counts from is named once, here, in
          text; each chip carries the balance's own age as text, and the rest
          of how it is counted is behind one tap. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-money text-[2.1rem] tabular">{amount(data.totalBalance)}</span>
        <span className="text-[0.78rem] text-faint">net worth</span>
      </div>
      <p className="pb-2 pt-1 text-[0.78rem] text-faint">
        {data.lastSyncAt === null ? (
          "No sync has finished successfully yet, so the balance ages below have nothing to measure against."
        ) : (
          <>
            Last successful sync <span className="font-money">{dateTime(data.lastSyncAt)}</span>
            {behind > 0
              ? `; ${behind} ${behind === 1 ? "account is" : "accounts are"} behind it.`
              : "; every balance is current."}
          </>
        )}
      </p>
      <div className="mb-3 empty:hidden">
        <StaleAlert
          accounts={data.groups.flatMap((g) =>
            g.accounts.map((a) => ({
              name: a.name,
              connectorType: a.connectorType,
              balanceLagDays: a.balanceLagDays,
              behind: a.staleByAge,
            })),
          )}
        />
      </div>
      <details className="pb-3">
        <summary className="tap44 inline-flex cursor-pointer items-center text-[0.75rem] text-acc hover:underline">
          How ages and history are counted
        </summary>
        <ul className="grid max-w-[60ch] gap-1 text-[0.78rem] text-faint">
          <li>A balance age counts from the last successful sync, not from today: a row is not late when the sync itself is.</li>
          <li>A red chip means the balance is that many days older than the last sync; its own age is printed under it.</li>
          <li>Snapshots are the balances a sync recorded. Without them, past months are rebuilt from transactions and marked estimated.</li>
        </ul>
      </details>
      <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-ink">
            {COLUMNS.map((c, i) => (
              <th
                scope="col"
                key={`${c.label}-${i}`}
                className={`py-1 pr-3 ${COLUMN_HEADER} ${c.className}`}
              >
                {c.label === "" ? <span className="sr-only">Transactions</span> : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.groups.map((group) => (
            <Fragment key={group.type}>
              <tr>
                <td
                  colSpan={6}
                  className="pb-1 pt-4 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint"
                >
                  {group.label}
                </td>
              </tr>
              {group.accounts.map((a) => (
                <tr key={a.id} className="border-b border-rule">
                  <td className="py-2 pr-3 text-[0.85rem]">
                    {a.name}{" "}
                    {/* The cash override is invisible everywhere else, and this
                        is the page that offers a TYPE dropdown — the control
                        liquidity.ts documents as the obvious wrong fix for
                        exactly this account. Stating the override beside it is
                        what stops the dropdown reading as the answer. */}
                    <span className="block text-[0.72rem] text-faint md:inline">
                      {a.institution} · {a.connectorType.toLowerCase()}
                      {a.isCash && a.type !== "DEPOSITORY" ? " · counts as cash" : ""}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <span
                      className={`font-money text-[0.85rem] tabular ${a.balance < 0 ? "font-semibold text-neg" : ""}`}
                    >
                      {a.balanceUnknown ? "unknown" : amount(a.balance)}
                    </span>
                    <span className="block text-[0.68rem] text-faint">
                      {/* The ISO form wrapped at its own hyphen in this narrow
                          cell on a phone; the short form fits. */}
                      as of <span className="md:hidden">{shortDate(new Date(a.balanceDate))}</span>
                      <span className="hidden md:inline">{a.balanceDate}</span>
                      {/* The printed number measures against the LAST SYNC, as
                          Overview's column does — a row saying "6d behind"
                          when nothing has synced for six days is reporting the
                          sync's problem in the account's voice. The chip still
                          fires on health's tuned now-based threshold, so an
                          overdue sync is not silently swallowed; the tooltip
                          carries both clocks and asserts no cause, because
                          this page cannot tell a stalled feed from a late
                          sync and used to claim it could. */}
                      {a.staleByAge && (
                        <>
                          <span className={`${CHIP} ml-1.5 bg-neg text-paper`}>{a.balanceLagDays}d behind</span>
                          <span className="block">balance is {a.daysSinceBalance}d old</span>
                        </>
                      )}
                    </span>
                  </td>
                  <td className="hidden py-2 pr-3 md:table-cell">
                    {a.snapshotCount >= 2 ? (
                      <span className="inline-flex items-center gap-2">
                        <Sparkline values={a.snapshotSeries} totalCount={a.snapshotCount} />
                        <span className="text-[0.68rem] text-faint">
                          {a.snapshotCount} snapshots, latest {a.latestSnapshotDate}
                          {a.snapshotCount > a.snapshotSeries.length && (
                            <span className="text-faint"> · last {a.snapshotSeries.length} shown</span>
                          )}
                        </span>
                      </span>
                    ) : (
                      <span className="text-[0.72rem] text-faint">
                        {a.snapshotCount === 1 ? "1 snapshot" : "no snapshots; history estimated"}
                      </span>
                    )}
                  </td>
                  <td className="hidden py-2 pr-3 text-[0.75rem] text-faint md:table-cell">
                    {a.txnCount > 0 ? (
                      <>
                        <span className="font-money tabular">{a.txnCount}</span> txns · last {a.lastTxnDate}
                      </>
                    ) : (
                      "no transactions"
                    )}
                  </td>
                  <td className="hidden py-2 pr-3 md:table-cell">
                    <AccountTypeSelect accountId={a.id} accountName={a.name} type={a.type} />
                  </td>
                  <td className="py-2 text-right">
                    <Link
                      href={accountsHref([a.id])}
                      className="inline-flex min-h-[44px] items-center justify-end whitespace-nowrap text-[0.75rem] text-acc hover:underline md:min-h-0"
                      aria-label={`View ${a.name} transactions`}
                    >
                      transactions →
                    </Link>
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
          <tr>
            {/* Explicitly sized: this cell alone carried no text-size class, so it
                  inherited 16px while the figure it names is 13.6px — the label
                  outweighing its own number. */}
              <th scope="row" className="border-t-2 border-ink py-2 text-left text-[0.85rem] font-semibold">
                Net worth
              </th>
            <td className="border-t-2 border-ink py-2 text-right font-money text-[0.85rem] font-semibold tabular">
              {amount(data.totalBalance)}
            </td>
            <td className="border-t-2 border-ink" colSpan={4} />
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  );
}
