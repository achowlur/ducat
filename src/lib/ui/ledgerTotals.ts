/**
 * What a list of ledger rows adds up to: money out, money in, the net of the
 * two, and transfers counted apart.
 *
 * Transfers stay out of the net for the reason they stay out of every
 * spending figure: moving money between your own accounts is neither
 * spending nor income, and a net that included them would change with how
 * many sides of a transfer the filters happen to show. They are still
 * COUNTED, in both directions, so every row on view is accounted for by one
 * of the figures and none is silently dropped.
 *
 * REPAID is the one figure that comes from rows the list does not show:
 * linked repayments of the bills in it (ui/repaid.ts). It is netted, because
 * the analyzers net it, and without it a category view printed a bill split
 * three ways as the whole charge while /trends printed a third.
 *
 * The trip band's net is a different figure on purpose (the signed sum of
 * every tagged row, transfers included, and it says so). The two agree once
 * this one's transfers are added back and its repaid taken out:
 * net − repaid + transfers.in − transfers.out.
 */
import type { Repaid } from "./repaid";

export interface LedgerTotals {
  /** Rows summed, transfers among them. */
  count: number;
  /** Money out, as a positive magnitude. */
  out: number;
  in: number;
  /** Paid back on the bills in `out` by linked repayments the list does not show. */
  repaid: Repaid;
  /** `in + repaid − out`: negative when more went out than came back. */
  net: number;
  transfers: { count: number; out: number; in: number };
}

/**
 * Summed in whole CENTS. A page is a hundred rows and the overall total can
 * be every row in the database; adding that many two-decimal floats drifts,
 * and a total that disagrees with its own rows by a cent is the one bug a
 * totals line exists to rule out.
 */
export function ledgerTotals(
  rows: readonly { flow: string; amount: number }[],
  repaid: Repaid = { amount: 0, count: 0 },
): LedgerTotals {
  let out = 0;
  let inflow = 0;
  let transferCount = 0;
  let transferOut = 0;
  let transferIn = 0;
  for (const row of rows) {
    const cents = Math.round(row.amount * 100);
    if (row.flow === "TRANSFER") {
      transferCount += 1;
      if (cents < 0) transferOut -= cents;
      else transferIn += cents;
    } else if (row.flow === "OUTFLOW") {
      out -= cents;
    } else {
      inflow += cents;
    }
  }
  const repaidCents = Math.round(repaid.amount * 100);
  return {
    count: rows.length,
    out: out / 100,
    in: inflow / 100,
    repaid: { amount: repaidCents / 100, count: repaid.count },
    net: (inflow + repaidCents - out) / 100,
    transfers: { count: transferCount, out: transferOut / 100, in: transferIn / 100 },
  };
}
