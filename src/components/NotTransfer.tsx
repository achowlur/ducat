"use client";

import { useState, useTransition } from "react";
import { markNotTransfer } from "../app/transactions/actions";
import { refuse } from "../lib/actionResult";
import { CONTROL } from "./ui/headings";

/**
 * The way out of a transfer a RULE flagged by wording (lib/sync/releaseTransfer.ts).
 * Rendered only beside a transfer with no pair, outside an investment account:
 * the one shape a person can disagree with one row at a time. On success the
 * page re-renders the row with its ordinary controls, the reimbursement
 * picker among them; a refusal is said beside the control in the action's
 * own words, dismissable, as the ledger's other controls say theirs.
 */
export function NotTransfer({ transactionId }: { transactionId: string }) {
  const [pending, startTransition] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        aria-disabled={pending}
        onClick={() => {
          if (pending) return;
          setRefusal(null);
          startTransition(async () => {
            // A call that never comes back is said here too, never left to
            // the page's error boundary, which cannot say what happened.
            const result = await markNotTransfer(transactionId).catch(() =>
              refuse("The change did not come back. Reload to see whether it was saved."),
            );
            if (!result.ok) setRefusal(result.message);
          });
        }}
        className={`tap44 ${CONTROL} border-rule text-faint hover:border-acc hover:text-acc ${pending ? "opacity-50" : ""}`}
      >
        Not a transfer
      </button>
      {refusal !== null && (
        <span role="alert" className="flex max-w-[220px] items-start gap-1">
          <span className="pt-0.5 text-[0.7rem] text-neg">{refusal}</span>
          <button
            type="button"
            onClick={() => setRefusal(null)}
            className="tap44 shrink-0 px-1 text-[0.7rem] text-faint hover:text-ink"
            aria-label="Dismiss this message"
          >
            ×
          </button>
        </span>
      )}
    </span>
  );
}
