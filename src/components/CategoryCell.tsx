"use client";

import { useState, useTransition } from "react";
import { createRuleFromMerchant, setTransactionCategory } from "../app/transactions/actions";

export interface CategoryOption {
  id: string;
  name: string;
  isIncome: boolean;
}

/**
 * Per-row category control: a select that writes a MANUAL assignment,
 * plus "rule" — one click turns this merchant into a user rule that
 * categorizes its past and future transactions.
 */
export function CategoryCell({
  transactionId,
  merchant,
  categoryId,
  categorySource,
  categories,
}: {
  transactionId: string;
  merchant: string;
  categoryId: string | null;
  categorySource: string;
  categories: CategoryOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [ruleMode, setRuleMode] = useState(false);

  const onSelect = (value: string, asRule: boolean) => {
    startTransition(async () => {
      if (asRule && value !== "") {
        await createRuleFromMerchant(merchant, value);
        setRuleMode(false);
      } else {
        await setTransactionCategory(transactionId, value === "" ? null : value);
      }
    });
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        value={ruleMode ? "" : (categoryId ?? "")}
        disabled={pending}
        onChange={(e) => onSelect(e.target.value, ruleMode)}
        className={`max-w-[130px] rounded-[2px] border bg-paper py-0.5 pl-1 pr-4 text-[0.78rem] ${
          ruleMode
            ? "border-acc text-acc"
            : categoryId === null
              ? "border-rule text-faint"
              : "border-transparent hover:border-rule"
        }`}
        title={
          ruleMode
            ? `Pick a category to create the rule: merchant contains "${merchant}"`
            : categorySource === "MANUAL"
              ? "Set manually"
              : categorySource === "RULE"
                ? "Set by rule"
                : "Uncategorized"
        }
      >
        <option value="">{ruleMode ? "rule: pick category…" : "—"}</option>
        <optgroup label="Spending">
          {categories.filter((c) => !c.isIncome).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="Income">
          {categories.filter((c) => c.isIncome).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      </select>
      {categorySource === "MANUAL" && categoryId !== null && !ruleMode && (
        <span className="text-[0.62rem] text-faint" title="Set manually — rules never override this">
          ✎
        </span>
      )}
      {merchant !== "" && (
        <button
          onClick={() => setRuleMode(!ruleMode)}
          disabled={pending}
          className={`rounded-[2px] border px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] ${
            ruleMode ? "border-acc bg-acc text-paper" : "border-rule text-faint hover:border-acc hover:text-acc"
          }`}
          title={`Create a rule for every "${merchant}" transaction, past and future`}
        >
          rule
        </button>
      )}
    </span>
  );
}
