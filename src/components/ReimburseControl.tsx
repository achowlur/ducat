"use client";

import { useState, useTransition } from "react";
import { linkReimbursement, unlinkReimbursement } from "../app/transactions/actions";

export interface ReimburseCandidate {
  id: string;
  label: string; // merchant/description
  date: string; // ISO date
  amount: number; // positive magnitude
  category: string | null;
}

/**
 * Ties an inflow to the outflow it pays back. Collapsed: a "link" button.
 * Expanded: nearby outflow candidates, ranked by date proximity. Linked:
 * a chip naming the original, with unlink.
 */
export function ReimburseControl({
  inflowId,
  linked,
  candidates,
}: {
  inflowId: string;
  linked: { label: string; date: string } | null;
  candidates: ReimburseCandidate[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  if (linked !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[0.75rem] text-acc" title="This inflow pays back the linked expense — analytics net it there">
        ↩ reimburses {linked.label} · {linked.date.slice(5)}
        <button
          onClick={() => startTransition(() => unlinkReimbursement(inflowId))}
          disabled={pending}
          className="rounded-[2px] border border-rule px-1 text-[0.62rem] text-faint hover:border-neg hover:text-neg"
          title="Unlink"
        >
          ×
        </button>
      </span>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-[2px] border border-rule px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc"
        title="This money pays back an expense — link it so spending nets correctly"
      >
        link
      </button>
    );
  }

  return (
    <span className="relative inline-block">
      <span className="absolute left-0 top-0 z-10 w-64 rounded-[3px] border border-ink bg-paper p-2 shadow-md">
        <span className="mb-1 block text-[0.65rem] uppercase tracking-[0.08em] text-faint">
          Pays back which expense?
        </span>
        {candidates.length === 0 && (
          <span className="block py-1 text-[0.75rem] text-faint">No nearby outflows found.</span>
        )}
        {candidates.map((c) => (
          <button
            key={c.id}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await linkReimbursement(inflowId, c.id);
                setOpen(false);
              })
            }
            className="block w-full rounded-[2px] px-1.5 py-1 text-left text-[0.75rem] hover:bg-chip"
          >
            <span className="font-money tabular">${c.amount.toFixed(2)}</span> {c.label}
            <span className="text-faint"> · {c.date.slice(5)}{c.category !== null ? ` · ${c.category}` : ""}</span>
          </button>
        ))}
        <button onClick={() => setOpen(false)} className="mt-1 block text-[0.68rem] text-faint hover:text-ink">
          cancel
        </button>
      </span>
    </span>
  );
}
