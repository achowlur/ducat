"use client";

import { useState, useTransition } from "react";
import { syncNow, type SyncNowResult } from "../app/actions";

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
        className="rounded-[2px] border border-rule px-1.5 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc disabled:opacity-60"
        title="Pull the latest from SimpleFIN now"
      >
        {pending ? "syncing…" : "sync now"}
      </button>
    </span>
  );
}
