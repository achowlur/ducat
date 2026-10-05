"use client";

import { useTransition } from "react";
import { setInsightDismissed } from "../app/insights/actions";
import { CONTROL } from "./ui/headings";

export function DismissButton({ insightId, dismissed }: { insightId: string; dismissed: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      onClick={() => startTransition(() => setInsightDismissed(insightId, !dismissed))}
      disabled={pending}
      // Below md the button fills a 44px touch target without a negative
      // margin: the row it sits in grows to match, so two adjacent dismiss
      // targets never overlap.
      className={`${CONTROL} inline-flex items-center justify-center max-md:min-h-[44px] max-md:min-w-[64px] ${
        dismissed
          ? "border-rule text-faint hover:border-pos hover:text-pos"
          : "border-rule text-faint hover:border-neg hover:text-neg"
      }`}
      title={
        dismissed
          ? "Restore this insight"
          : "Dismiss; stays dismissed even when insights regenerate after a sync"
      }
    >
      {dismissed ? "Restore" : "Dismiss"}
    </button>
  );
}
