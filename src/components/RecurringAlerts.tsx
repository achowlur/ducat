"use client";

import { useState, useTransition } from "react";
import { decideRecurring } from "../app/insights/actions";
import { settleAction } from "../lib/actionResult";
import type { RecurringAlert } from "../lib/ui/recurringAlerts";
import { ActionAlert, ALERT_ACTION } from "./ActionAlert";

/** What a button that never got an answer most likely was: nothing was saved. */
const NO_ANSWER = "That did not save, because the server stopped answering. Nothing changed; try again.";

function AlertRow({ alert }: { alert: RecurringAlert }) {
  const [pending, startTransition] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);

  function choose(choice: RecurringAlert["actions"][number]["choice"]) {
    setRefusal(null);
    startTransition(async () => {
      const result = await settleAction(() => decideRecurring({ plan: alert.plan, choice }), NO_ANSWER);
      if (!result.ok) setRefusal(result.message);
    });
  }

  return (
    <ActionAlert
      kind={alert.kind}
      detail={
        <>
          {alert.detail}
          {refusal !== null && <span className="mt-1 block text-warn-ink">{refusal}</span>}
        </>
      }
      actions={alert.actions.map((a) => (
        <button
          key={a.choice}
          type="button"
          disabled={pending}
          onClick={() => choose(a.choice)}
          className={`${ALERT_ACTION} cursor-pointer disabled:opacity-60`}
        >
          {a.label}
        </button>
      ))}
    >
      {alert.text}
    </ActionAlert>
  );
}

/**
 * The alerts at the top of Recurring charges: at most two in view, any more
 * folded behind a tap (never a hover). Each button saves a decision and the
 * page re-renders without the alert; a refusal is a sentence under the alert.
 */
export function RecurringAlerts({ shown, folded }: { shown: RecurringAlert[]; folded: RecurringAlert[] }) {
  if (shown.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-2">
      {shown.map((a) => (
        <AlertRow key={a.id} alert={a} />
      ))}
      {folded.length > 0 && (
        <details className="group">
          <summary className="tap44 flex cursor-pointer list-none items-center gap-1.5 text-[0.78rem] text-faint [&::-webkit-details-marker]:hidden">
            {folded.length} more to look at
            <span aria-hidden="true" className="text-[0.7rem] transition-transform group-open:rotate-90">
              ›
            </span>
          </summary>
          <div className="flex flex-col gap-2">
            {folded.map((a) => (
              <AlertRow key={a.id} alert={a} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
