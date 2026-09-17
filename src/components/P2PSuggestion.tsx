"use client";

import { useTransition } from "react";
import { setTransactionCategory } from "../app/transactions/actions";

/**
 * A pre-filled category for a P2P payment awaiting confirmation: one tap
 * accepts it, and the row becomes MANUAL — a person decided, so no rule can
 * move it afterwards. Declining needs no control of its own: picking any other
 * category in the row's picker is the decline.
 *
 * The reason is TEXT beside the button, never a title= — the operator reads
 * this on a phone, and "why this category" is the thing they are confirming.
 */
export function P2PSuggestion({
  transactionId,
  categoryId,
  categoryName,
  reason,
}: {
  transactionId: string;
  categoryId: string;
  categoryName: string;
  reason: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => setTransactionCategory(transactionId, categoryId))}
        className="tap44 rounded-[2px] border border-acc px-1.5 py-0.5 text-[0.72rem] text-acc hover:bg-acc hover:text-paper disabled:opacity-50"
        aria-label={`Confirm ${categoryName} for this payment`}
      >
        {pending ? "saving…" : `✓ ${categoryName}`}
      </button>
      <span className="text-[0.66rem] text-faint">{reason}</span>
    </span>
  );
}
