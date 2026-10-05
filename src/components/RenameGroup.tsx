"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { renameGroup } from "../app/transactions/actions";
import { groupHref, normalizeGroupLabel, MAX_GROUP_LABEL } from "../lib/ui/groupFilter";
import { ACTION_DID_NOT_COMPLETE } from "../lib/ui/boundaryCopy";
import { CONTROL } from "./ui/headings";

/**
 * The totals band's rename control: rewrites the label across the WHOLE
 * group — every row carrying the tag, not the filtered view the band happens
 * to sum — and says so, with the group's true row count. Renaming onto an
 * existing trip is a MERGE; the note appears the moment the typed name
 * matches one, before anything is written. A case-insensitive match adopts
 * the existing casing — the picker's fork-prevention applied here.
 */
export function RenameGroup({
  label,
  totalRows,
  labels,
}: {
  label: string;
  /** Rows carrying this tag ACROSS the whole ledger, not the filtered view. */
  totalRows: number;
  /** Every known trip label, for the merge note and case adoption. */
  labels: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(label);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const typed = normalizeGroupLabel(value);
  const existing =
    typed === null
      ? undefined
      : labels.find((l) => l !== label && l.toLowerCase() === typed.toLowerCase());
  const target = existing ?? typed;
  const merge = existing !== undefined;
  const unchanged = target === label;

  const commit = () => {
    if (pending || target === null || unchanged) return;
    setFailure(null);
    startTransition(async () => {
      try {
        // The action returns the label it actually wrote (it re-adopts an
        // existing group's casing server-side — this list can be stale).
        const written = await renameGroup(label, target);
        if (!written.ok) {
          setFailure(written.message);
          return;
        }
        // The old ?group= URL would show the honest-but-jarring empty band;
        // land on the renamed group instead. groupHref writes ?group= alone,
        // deliberately dropping period/account/flow/q — after a rename the
        // whole group is the natural view.
        router.replace(groupHref(written.label));
        setOpen(false);
      } catch {
        // Not "retry": a lapsed sign-in fails identically (boundaryCopy.ts).
        setFailure(ACTION_DID_NOT_COMPLETE);
      }
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(label);
          setFailure(null);
          setOpen(true);
        }}
        className={`${CONTROL} tap44 border-rule text-faint hover:border-acc hover:text-acc`}
        title={`Rename “${label}” across every row that carries it`}
      >
        Rename
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <input
        ref={inputRef}
        type="text"
        value={value}
        maxLength={MAX_GROUP_LABEL}
        onChange={(e) => {
          setValue(e.target.value);
          setFailure(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        aria-label="New trip name"
        className="rounded-[2px] border border-rule bg-paper px-1.5 py-0.5 text-[0.8rem] outline-none focus:border-acc"
      />
      <button
        type="button"
        aria-disabled={pending || target === null || unchanged}
        onClick={commit}
        className={`${CONTROL} tap44 border-rule text-faint hover:border-acc hover:text-acc`}
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="tap44 text-[0.75rem] text-faint hover:text-ink"
      >
        Cancel
      </button>
      <span className={`w-full text-[0.72rem] ${failure !== null ? "text-neg" : "text-faint"}`}>
        {failure !== null
          ? failure
          : merge
            ? `“${existing}” already exists; saving MERGES the two into one group.`
            : `renames every row carrying this tag, ${totalRows} in total, filters or not`}
      </span>
    </span>
  );
}
