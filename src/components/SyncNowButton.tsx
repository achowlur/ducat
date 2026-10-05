"use client";

import { useState, useTransition } from "react";
import { syncNow, type SyncNowResult } from "../app/actions";
import { CONTROL } from "./ui/headings";

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
      setResult(await syncNow());
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
