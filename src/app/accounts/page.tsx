import { Fragment } from "react";
import Link from "next/link";
import { AccountTypeSelect } from "../../components/AccountTypeSelect";
import { Sparkline } from "../../components/Sparkline";
import { amount, dateTime } from "../../lib/ui/format";
import { getAccountsData } from "../../lib/ui/accounts";
import { PageTitle } from "../../components/ui/headings";
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

  if (data.groups.length === 0) {
    return (
      <p className="py-10 text-faint">No accounts yet. Run a sync or seed fixture data.</p>
    );
  }

  return (
    <div className="py-5">
      <PageTitle>Accounts</PageTitle>
      {/* The clock every "Nd behind" below is measured against. Overview has
          carried this instant since it was built; this page did not, so its
          rows quoted an age against something the reader could not see — the
          one thing that made the same figure harder to read here than there.
          It also retires a `title=`: the row chip's tooltip existed to carry
          the second clock, and hover is not an affordance on the device this
          is read on. */}
      <p className="pb-3 text-[0.78rem] text-faint">
        {data.lastSyncAt === null ? (
          "No sync has finished successfully yet, so the balance ages below have nothing to measure against."
        ) : (
          <>
            Balance ages below count from the last successful sync,{" "}
            <span className="font-money">{dateTime(data.lastSyncAt)}</span>.
          </>
        )}
      </p>
      <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-ink">
            {COLUMNS.map((c, i) => (
              <th
                scope="col"
                key={`${c.label}-${i}`}
                className={`py-1 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint ${c.className}`}
              >
                {c.label}
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
                    <span className="text-[0.72rem] text-faint">
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
                      as of {a.balanceDate}
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
                        <span
                          className="ml-1.5 rounded-[2px] bg-neg px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.05em] text-paper"
                          title={`${a.balanceLagDays}d behind at the last sync; the balance itself is ${a.daysSinceBalance}d old`}
                        >
                          {a.balanceLagDays}d behind
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="hidden py-2 pr-3 md:table-cell">
                    {a.snapshotCount >= 2 ? (
                      <span className="inline-flex items-center gap-2" title={`${a.snapshotCount} balance snapshots, latest ${a.latestSnapshotDate}`}>
                        <Sparkline values={a.snapshotSeries} totalCount={a.snapshotCount} />
                        <span className="text-[0.68rem] text-faint">
                          {a.snapshotCount} snapshots
                          {a.snapshotCount > a.snapshotSeries.length && (
                            <span className="text-faint"> · last {a.snapshotSeries.length} shown</span>
                          )}
                        </span>
                      </span>
                    ) : (
                      <span
                        className="text-[0.72rem] text-faint"
                        title="Balances for past months are reconstructed from transactions until syncs write snapshots"
                      >
                        {a.snapshotCount === 1 ? "1 snapshot" : "no snapshots — history estimated"}
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
                      href={`/transactions?account=${a.id}`}
                      className="inline-flex min-h-[44px] items-center justify-end whitespace-nowrap text-[0.75rem] text-acc hover:underline md:min-h-0"
                      title={`View ${a.name} transactions`}
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
