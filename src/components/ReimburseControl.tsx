"use client";

import { useState, useTransition } from "react";
import { linkReimbursement, suggestCandidates, unlinkReimbursement } from "../app/transactions/actions";
import type { ReimburseCandidate } from "../lib/ui/reimburseCandidates";

/**
 * Ties an inflow to the outflow it pays back. Collapsed: a "link" button, with
 * a dot when a strong match is waiting. Expanded: candidates ranked by amount
 * evidence first (see suggestReimbursements), each showing why it matched.
 * Linked: a chip naming the original, with unlink.
 *
 * The candidate LIST is fetched when the picker opens (`suggestCandidates`),
 * not serialized into every row — a ledger page was carrying 400+ candidate
 * objects in its HTML for pickers nobody opened. The collapsed state needs
 * only `strongHint`, which the page still computes per row.
 */
export function ReimburseControl({
  inflowId,
  linked,
  strongHint,
}: {
  inflowId: string;
  linked: { label: string; date: string } | null;
  /** The best strong candidate, for the collapsed button's dot and tooltip. */
  strongHint: { label: string; reason: string } | null;
}) {
  const [open, setOpen] = useState(false);
  // null = not fetched yet (the picker shows a quiet loading line).
  const [candidates, setCandidates] = useState<ReimburseCandidate[] | null>(null);
  // A failed fetch must not read as "still looking" — or as "none found".
  const [failed, setFailed] = useState(false);
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
        onClick={() => {
          setOpen(true);
          // Refetched on every open: the pool can change between renders
          // (a link elsewhere, a sync), and stale suggestions are worse
          // than a beat of loading.
          setCandidates(null);
          setFailed(false);
          startTransition(async () => {
            try {
              setCandidates(await suggestCandidates(inflowId));
            } catch {
              setFailed(true);
            }
          });
        }}
        className={`rounded-[2px] border px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] ${
          strongHint === null
            ? "border-rule text-faint hover:border-acc hover:text-acc"
            : "border-acc text-acc hover:bg-chip"
        }`}
        title={
          strongHint === null
            ? "This money pays back an expense — link it so spending nets correctly"
            : `Likely pays back ${strongHint.label} (${strongHint.reason})`
        }
      >
        link{strongHint === null ? "" : " •"}
      </button>
    );
  }

  return (
    <span className="relative inline-block">
      <span className="absolute left-0 top-0 z-10 w-64 rounded-[3px] border border-ink bg-paper p-2 shadow-md">
        <span className="mb-1 block text-[0.65rem] uppercase tracking-[0.08em] text-faint">
          Pays back which expense?
        </span>
        {candidates === null && !failed && (
          <span className="block py-1 text-[0.75rem] text-faint">Looking for nearby outflows…</span>
        )}
        {failed && (
          <span className="block py-1 text-[0.75rem] text-faint">Couldn&apos;t load suggestions — close and retry.</span>
        )}
        {candidates !== null && candidates.length === 0 && (
          <span className="block py-1 text-[0.75rem] text-faint">No nearby outflows found.</span>
        )}
        {(candidates ?? []).map((c) => (
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
            <span className={`block text-[0.65rem] ${c.strong ? "text-acc" : "text-faint"}`}>{c.reason}</span>
          </button>
        ))}
        <button onClick={() => setOpen(false)} className="mt-1 block text-[0.68rem] text-faint hover:text-ink">
          cancel
        </button>
      </span>
    </span>
  );
}
