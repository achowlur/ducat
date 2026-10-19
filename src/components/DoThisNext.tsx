"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { markNudgeDone } from "../app/actions";
import { settleAction } from "../lib/actionResult";
import type { NextAction } from "../lib/ui/nextAction";
import { ActionAlert, ALERT_ACTION } from "./ActionAlert";
import { FIELD_LABEL } from "./ui/headings";

/** What a button that never got an answer most likely was: nothing was saved. */
const NO_ANSWER = "That did not save, because the server stopped answering. Nothing changed; try again.";

const waitingNote = (n: number) =>
  `${n} marked done ${n === 1 ? "waits" : "wait"} for newer data, and ${n === 1 ? "comes" : "come"} back if still true.`;

/**
 * Overview's "Do this next" slot. It is never empty: with nothing to do it
 * STATES all clear, in quiet text rather than an alert, because all clear
 * cannot be told from not checked when it is only implied by absence.
 */
export function DoThisNext({ next, checked }: { next: NextAction; checked: boolean }) {
  const [pending, startTransition] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);
  const lead = next.lead;

  if (lead === null) {
    return (
      <div className="text-[0.85rem]">
        <div className={FIELD_LABEL}>Do this next</div>
        <p className="text-faint">
          {checked ? "All clear." : "Nothing to check until the first sync."}
          {checked && next.waiting > 0 && ` ${waitingNote(next.waiting)}`}
        </p>
      </div>
    );
  }

  function done(key: string) {
    setRefusal(null);
    startTransition(async () => {
      const result = await settleAction(() => markNudgeDone({ key }), NO_ANSWER);
      if (!result.ok) setRefusal(result.message);
    });
  }

  const then = next.then.map((n) => n.short).join(" · ");
  return (
    <div>
      <ActionAlert
        lead
        kind="Do this next"
        detail={
          then === "" && refusal === null ? undefined : (
            <>
              {then !== "" && `Then: ${then}`}
              {refusal !== null && <span className="mt-1 block text-warn-ink">{refusal}</span>}
            </>
          )
        }
        actions={
          <>
            <Link href={lead.href} className={ALERT_ACTION}>
              Details
            </Link>
            <button
              type="button"
              disabled={pending}
              onClick={() => done(lead.key)}
              className={`${ALERT_ACTION} cursor-pointer disabled:opacity-60`}
            >
              Mark done
            </button>
          </>
        }
      >
        {lead.text}
      </ActionAlert>
    </div>
  );
}
