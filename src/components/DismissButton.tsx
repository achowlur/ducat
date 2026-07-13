"use client";

import { useTransition } from "react";
import { setInsightDismissed } from "../app/insights/actions";

export function DismissButton({ insightId, dismissed }: { insightId: string; dismissed: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      onClick={() => startTransition(() => setInsightDismissed(insightId, !dismissed))}
      disabled={pending}
      className={`rounded-[2px] border px-1.5 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] ${
        dismissed
          ? "border-rule text-faint hover:border-pos hover:text-pos"
          : "border-rule text-faint hover:border-neg hover:text-neg"
      }`}
      title={
        dismissed
          ? "Restore this insight"
          : "Dismiss — stays dismissed even when insights regenerate after a sync"
      }
    >
      {dismissed ? "restore" : "dismiss"}
    </button>
  );
}
