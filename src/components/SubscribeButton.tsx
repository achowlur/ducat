"use client";

import { useState, useTransition } from "react";
import type { RecurringCadence } from "../types/contracts";
import { registerSubscription, unregisterSubscription } from "../app/transactions/actions";

/**
 * Track this merchant as a subscription, from the row you noticed it on.
 *
 * Sits beside `rule` because it is the same shape of decision — "this merchant,
 * from now on" — and because that is where the hand already goes. Everything a
 * TrackedSubscription needs is on the row except the cadence, so the cadence is
 * the only thing asked for, revealed inline rather than in a popover: it is
 * four options on one row at a time, not fifteen on every row.
 */
const CADENCES: { value: RecurringCadence; label: string }[] = [
  { value: "WEEKLY", label: "wk" },
  { value: "MONTHLY", label: "mo" },
  { value: "QUARTERLY", label: "qtr" },
  { value: "YEARLY", label: "yr" },
];

export function SubscribeButton({
  transactionId,
  merchantPattern,
  tracked,
}: {
  transactionId: string;
  /** Null when this row can't be tracked — no merchant, or too short to match safely. */
  merchantPattern: string | null;
  tracked: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (merchantPattern === null) return null;

  if (tracked) {
    return (
      <button
        type="button"
        aria-disabled={pending}
        onClick={() => {
          if (pending) return;
          startTransition(async () => {
            await unregisterSubscription(merchantPattern);
          });
        }}
        className={`rounded-[2px] border border-acc bg-acc px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-paper ${
          pending ? "opacity-50" : ""
        }`}
        title={`Tracked as a subscription (matching "${merchantPattern}") — click to stop tracking`}
      >
        sub ✓
      </button>
    );
  }

  if (choosing) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className="font-money text-[0.58rem] uppercase tracking-[0.05em] text-faint">every</span>
        {CADENCES.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-disabled={pending}
            onClick={() => {
              if (pending) return;
              setError(null);
              startTransition(async () => {
                try {
                  await registerSubscription(transactionId, c.value);
                  setChoosing(false);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Could not track this one.");
                }
              });
            }}
            className="rounded-[2px] border border-rule px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc"
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setChoosing(false);
            setError(null);
          }}
          className="text-[0.62rem] text-faint hover:text-ink"
        >
          ×
        </button>
        {error !== null && <span className="text-[0.62rem] text-neg">{error}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setChoosing(true)}
      className="rounded-[2px] border border-rule px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc"
      title="Track this merchant as a subscription — gives you its next renewal date and price changes without waiting for the detector's three charges"
    >
      sub
    </button>
  );
}
