"use client";

import { useTransition } from "react";
import { setAccountType } from "../app/accounts/actions";

const TYPES = [
  { value: "DEPOSITORY", label: "Depository" },
  { value: "INVESTMENT", label: "Investment" },
  { value: "CREDIT", label: "Credit" },
  { value: "LOAN", label: "Loan" },
];

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
      title="Account type — corrections survive future syncs and recompute all insights"
    >
      {TYPES.map((t) => (
        <option key={t.value} value={t.value}>
          {t.label}
        </option>
      ))}
    </select>
  );
}
