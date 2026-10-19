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

/**
 * Overview's "Do this next" slot. With nothing to do it is EMPTY (operator,
 * 2026-10-19: an "All clear" box, good news and all, was space spent saying
 * nothing); Needs review below still states its own all clear, so a quiet
 * page is still told from an unchecked one. Before the first sync it says
 * there is nothing to check yet.
 */
export function DoThisNext({ next, checked }: { next: NextAction; checked: boolean }) {
  const [pending, startTransition] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);
  const lead = next.lead;

  if (lead === null && !checked) {
    return (
      <div className="text-[0.85rem]">
        <div className={FIELD_LABEL}>Do this next</div>
        <p className="text-faint">Nothing to check until the first sync.</p>
      </div>
    );
  }

  if (lead === null) return null;

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
