"use client";

import { useState, useTransition } from "react";
import { syncNow, type SyncNowResult } from "../app/actions";
import { settleAction } from "../lib/actionResult";
import { CONTROL } from "./ui/headings";

/**
 * What a sync that never answered most likely was: a function stopped at its
 * 60s limit. What it saved stays, and the next sync finishes the rest: it
 * refetches the same window and applies rules to rows left waiting (sync.ts).
 */
export const SYNC_NO_ANSWER =
  "The sync stopped answering, most likely at the server's time limit. Anything it saved is kept, and the next sync picks up the rest.";

/**
 * On-demand refresh. Pulls the latest from SimpleFIN whenever you tap it —
 * never staler than SimpleFIN itself (which refreshes ~daily). Shown only when
 * a SimpleFIN feed is configured.
 */
export function SyncNowButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SyncNowResult | null>(null);

  function handleClick() {
    setResult(null);
    startTransition(async () => {
      setResult(await settleAction(syncNow, SYNC_NO_ANSWER));
    });
  }

  return (
    <span className="flex items-center gap-2">
      {result !== null && (
        <span className={result.ok ? "text-pos" : "text-neg"}>{result.message}</span>
      )}
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className={`${CONTROL} tap44 cursor-pointer border-rule text-faint hover:border-acc hover:text-acc disabled:opacity-60`}
        title="Pull the latest from SimpleFIN now"
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>
    </span>
  );
}
