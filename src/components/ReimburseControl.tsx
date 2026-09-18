"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { linkReimbursement, searchReimbursable, suggestCandidates, unlinkReimbursement } from "../app/transactions/actions";
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
 *
 * Escape, click-outside and focus restore are the same three affordances the
 * category picker and its `rule` menu each had to be given, for the third time
 * and the same reason: without them this panel had no dismissal but its own
 * cancel link, so opening a second one left BOTH open — two 256px popovers
 * stacked over the ledger, the lower one covering the upper one's remaining
 * candidates AND its cancel. Observed on the deployment, not deduced.
 * Click-outside is also what makes "only one open" fall out for free: another
 * row's trigger is outside this panel.
 *
 * The trigger therefore stays MOUNTED while the panel is open (it used to be
 * replaced by it). Escape has somewhere to put focus back, and the anchor
 * cannot be measured while detached — the trap the category picker records.
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
  // The search box: the ranked list is a guess capped at a dozen, and a
  // repayment that is no clean share of its expense can rank far below it.
  // Searching reaches every expense in the window. null = not searching.
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReimburseCandidate[] | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    // Debounced, and a stale answer is dropped if the query moved on.
    let current = true;
    const timer = setTimeout(() => {
      searchReimbursable(inflowId, q)
        .then((found) => {
          if (current) setResults(found);
        })
        .catch(() => {
          if (current) setResults([]);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query, inflowId]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);

  // Clicking away leaves focus where it was clicked; dismissing with the
  // keyboard has to hand it back, or Escape strands you at the top of a
  // 100-row ledger.
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close(true);
    };
    // The trigger is excluded so it can toggle: without that, its own mousedown
    // would close the panel and its click would immediately reopen it.
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (panelRef.current?.contains(node) === true) return;
      if (triggerRef.current?.contains(node) === true) return;
      close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, close]);

  if (linked !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[0.75rem] text-acc" title="This inflow pays back the linked expense — analytics net it there">
        ↩ reimburses {linked.label} · {linked.date.slice(5)}
        <button
          onClick={() => startTransition(() => unlinkReimbursement(inflowId))}
          disabled={pending}
          className="tap44 rounded-[2px] border border-rule px-1 text-[0.62rem] text-faint hover:border-neg hover:text-neg"
          title="Unlink"
        >
          ×
        </button>
      </span>
    );
  }

  return (
    <span className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close(true);
            return;
          }
          setOpen(true);
          setQuery("");
          setResults(null);
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
        className={`tap44 rounded-[2px] border px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] ${
          open
            ? "border-acc bg-acc text-paper"
            : strongHint === null
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
      {open && (
        <span
          ref={panelRef}
          // Opens LEFTWARD on a phone. The ledger scrolls horizontally below md
          // and this control sits at the right end of the row, so a left-anchored
          // panel put 138 of its 256px past the scroller's edge — measured at
          // 375px, and you have to have scrolled the trigger into view to click
          // it, which is exactly the window right-anchoring lands the panel in.
          className="absolute right-0 top-full z-10 mt-1 w-64 rounded-[3px] border border-ink bg-paper p-2 shadow-md md:left-0 md:right-auto"
        >
          <span className="mb-1 block text-[0.65rem] uppercase tracking-[0.08em] text-faint">
            {/* Names the ordering, so a list that ends is not read as the list
                of everything in range — it is the closest matches, ranked. */}
            Pays back which expense? · {results === null ? "closest first" : "search results"}
          </span>
          {/* 16px on a phone: smaller type makes iOS zoom the page on focus. */}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search merchant or amount"
            aria-label="Search expenses to link"
            className="tap44 mb-1 w-full rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-base text-ink outline-none focus:border-acc md:text-[0.75rem]"
          />
          {results !== null && results.length === 0 && (
            <span className="block py-1 text-[0.75rem] text-faint">No expense in range matches “{query.trim()}”.</span>
          )}
          {results === null && candidates === null && !failed && (
            <span className="block py-1 text-[0.75rem] text-faint">Looking for nearby outflows…</span>
          )}
          {results === null && failed && (
            <span className="block py-1 text-[0.75rem] text-faint">Couldn&apos;t load suggestions — close and retry.</span>
          )}
          {results === null && candidates !== null && candidates.length === 0 && (
            <span className="block py-1 text-[0.75rem] text-faint">No nearby outflows found.</span>
          )}
          {/* Scrolls rather than growing: the list is longer than it was, and a
              popover that runs off the bottom of a phone is not a longer list,
              it is a shorter one. */}
          <span className="block max-h-[17rem] overflow-y-auto">
            {(results ?? candidates ?? []).map((c) => (
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
          </span>
          <button onClick={() => close(true)} className="mt-1 block text-[0.68rem] text-faint hover:text-ink">
            cancel
          </button>
        </span>
      )}
    </span>
  );
}
