"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { markNudgeDone } from "../app/actions";
import { settleAction } from "../lib/actionResult";
import type { GoodNews } from "../lib/ui/goodNews";
import type { NextAction } from "../lib/ui/nextAction";
import { ActionAlert, ALERT_ACTION } from "./ActionAlert";
import { FIELD_LABEL } from "./ui/headings";

/** What a button that never got an answer most likely was: nothing was saved. */
const NO_ANSWER = "That did not save, because the server stopped answering. Nothing changed; try again.";

/**
 * The lead alert's height with a one-line sentence, so swapping it for all
 * clear does not move what sits below: below md its 44px controls wrap under
 * the sentence (py-3, a line, the gap, 44px: 98px); from md they sit beside
 * it (48px).
 */
const ALL_CLEAR_HEIGHT = "min-h-[6.125rem] md:min-h-12";

const waitingNote =(n: number) =>
  `${n} marked done ${n === 1 ? "waits" : "wait"} for newer data, and ${n === 1 ? "comes" : "come"} back if still true.`;

/**
 * Overview's "Do this next" slot. It is never empty: with nothing to do it
 * STATES all clear, because all clear cannot be told from not checked when it
 * is only implied by absence. All clear is not an alert: a quiet positive
 * rule on the chip paper, its one line of true good news (goodNews.ts) in
 * ink, the box the alert's height so the row does not jump between the two.
 */
export function DoThisNext({ next, checked, news = null }: { next: NextAction; checked: boolean; news?: GoodNews | null }) {
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

  if (lead === null) {
    return (
      <div className={`flex flex-col justify-center border-l-4 border-pos bg-chip px-4 py-3 ${ALL_CLEAR_HEIGHT}`}>
        <p className="text-[0.98rem] leading-snug text-ink">
          {news === null ? (
            "All clear."
          ) : (
            <>
              <span className={`${FIELD_LABEL} mr-2`}>All clear</span>
              {news.before}
              {news.figure !== "" && (
                <>
                  {" "}
                  <span className="font-money">{news.figure}</span>
                </>
              )}{" "}
              {news.after}
            </>
          )}
        </p>
        {next.waiting > 0 && <p className="mt-1 text-[0.78rem] leading-relaxed text-faint">{waitingNote(next.waiting)}</p>}
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
