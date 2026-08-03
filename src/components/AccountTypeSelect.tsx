"use client";

import { useTransition } from "react";
import { setAccountType } from "../app/accounts/actions";
import type { AccountType } from "../types/contracts";

const LABELS: Record<AccountType, string> = {
  DEPOSITORY: "Depository",
  INVESTMENT: "Investment",
  CREDIT: "Credit",
  LOAN: "Loan",
};
// Display order, deliberately not alphabetical: assets before liabilities.
const TYPES: { value: AccountType; label: string }[] = (
  ["DEPOSITORY", "INVESTMENT", "CREDIT", "LOAN"] as const
).map((value) => ({ value, label: LABELS[value] }));

/**
 * Corrects the account type guessed at creation. Changing it recomputes
 * all insights (net-worth breakdown and market gains follow the type).
 */
export function AccountTypeSelect({ accountId, type }: { accountId: string; type: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <select
      value={type}
      disabled={pending}
      onChange={(e) => startTransition(() => setAccountType(accountId, e.target.value))}
      className="rounded-[2px] border border-transparent bg-paper py-0.5 pl-1 pr-4 text-[0.78rem] hover:border-rule"
      title="Account type — corrections survive future syncs and recompute all insights. Whether a balance counts as spendable cash is a separate setting (npm run accounts:cash), not a type."
    >
      {TYPES.map((t) => (
        <option key={t.value} value={t.value}>
          {t.label}
        </option>
      ))}
    </select>
  );
}
