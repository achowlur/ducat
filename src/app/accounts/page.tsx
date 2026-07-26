import { Fragment } from "react";
import Link from "next/link";
import { AccountTypeSelect } from "../../components/AccountTypeSelect";
import { Sparkline } from "../../components/Sparkline";
import { amount } from "../../lib/ui/format";
import { getAccountsData } from "../../lib/ui/accounts";

export const dynamic = "force-dynamic";

/**
 * Snapshot history and transaction counts are context, not the reason to open
 * this screen; below md they drop so account, balance and type fit a phone.
 */
const COLUMNS = [
  { label: "Account", className: "text-left" },
  { label: "Balance", className: "text-right" },
  { label: "History", className: "hidden text-left md:table-cell" },
  { label: "Activity", className: "hidden text-left md:table-cell" },
  { label: "Type", className: "text-left" },
  { label: "", className: "text-left" },
];

export default async function AccountsPage() {
  const data = await getAccountsData();

  if (data.groups.length === 0) {
    return (
      <p className="py-10 text-faint">No accounts yet. Run a sync or seed fixture data.</p>
    );
  }

  return (
    <div className="py-5">
      <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-ink">
            {COLUMNS.map((c, i) => (
              <th
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
                    <span className="text-[0.72rem] text-faint">
                      {a.institution} · {a.connectorType.toLowerCase()}
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
                      {a.staleByAge && (
                        <span
                          className="ml-1.5 rounded-[2px] bg-neg px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.05em] text-paper"
                          title={`Balance hasn't updated in ${a.daysSinceBalance} days — the provider feed may have silently stalled`}
                        >
                          stale · {a.daysSinceBalance}d
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="hidden py-2 pr-3 md:table-cell">
                    {a.snapshotCount >= 2 ? (
                      <span className="inline-flex items-center gap-2" title={`${a.snapshotCount} balance snapshots, latest ${a.latestSnapshotDate}`}>
                        <Sparkline values={a.snapshotSeries} />
                        <span className="text-[0.68rem] text-faint">{a.snapshotCount} snapshots</span>
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
                  <td className="py-2 pr-3">
                    <AccountTypeSelect accountId={a.id} type={a.type} />
                  </td>
                  <td className="py-2 text-right">
                    <Link
                      href={`/transactions?account=${a.id}`}
                      className="text-[0.75rem] text-acc hover:underline"
                      title="View this account's transactions"
                    >
                      transactions →
                    </Link>
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
          <tr>
            <td className="border-t-2 border-ink py-2 font-semibold">Net worth</td>
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
