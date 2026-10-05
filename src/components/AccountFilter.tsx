"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { accountFilterSummary, encodeAccountParam } from "../lib/ui/accountFilter";
import { FIELD_LABEL } from "./ui/headings";

export interface AccountOption {
  id: string;
  name: string;
  institution: string;
}

/** The panel's width (`w-64`), and how close it may come to the viewport's edge. */
const PANEL_WIDTH = 256;
const EDGE = 8;

/**
 * The ledger's account filter: any number of accounts at once. It was a
 * single-choice select, so comparing two cards meant two visits.
 *
 * The choice is STAGED, like every other control in this form: ticking a box
 * changes what will be asked for, and the form's submit (the panel's Apply, or
 * Filter beside it) asks. The collapsed control always says what is staged, so
 * a closed panel never hides a change.
 *
 * What travels is ONE hidden `account` field holding the list, not one field
 * per box: the page's links rebuild the query from single values, and a
 * repeated key would reach them as an array.
 *
 * Escape, click-outside and focus restore are owed by every popover on the
 * ledger (see ReimburseControl), and the trigger stays mounted for the same
 * two reasons: focus needs somewhere to return to, and the anchor is measured
 * at open.
 */
export function AccountFilter({
  accounts,
  selected,
}: {
  accounts: AccountOption[];
  /** The ids the page is filtered by now; empty means every account. */
  selected: string[];
}) {
  const [checked, setChecked] = useState<string[]>(selected);
  // null = closed. Otherwise how far the panel is pulled left of the trigger
  // to stay on screen, measured ONCE at open: the form wraps, so on a phone the
  // trigger can sit anywhere across the row and neither edge is a safe anchor.
  const [shift, setShift] = useState<number | null>(null);
  const open = shift !== null;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const valueId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setShift(null);
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
    // The measurement above is only good for the width it was taken at.
    const onResize = () => close(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  const toggle = (id: string) =>
    setChecked((current) => (current.includes(id) ? current.filter((c) => c !== id) : [...current, id]));

  const names = accounts.filter((a) => checked.includes(a.id)).map((a) => a.name);
  const value = encodeAccountParam(checked);

  return (
    <div className="relative grid gap-0.5">
      <span id={labelId} className={FIELD_LABEL}>
        Account
      </span>
      {/* Absent rather than empty when nothing is staged, so "every account"
          is no parameter at all. */}
      {value !== "" && <input type="hidden" name="account" value={value} />}
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => {
          if (open) {
            close(true);
            return;
          }
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect === undefined) {
            setShift(0);
            return;
          }
          const overflow = Math.max(0, rect.left + PANEL_WIDTH - (document.documentElement.clientWidth - EDGE));
          setShift(-Math.min(overflow, Math.max(0, rect.left - EDGE)));
        }}
        // `leading-[normal]` is what a native select uses whatever it
        // inherits; without it this stood 3px taller than the selects either
        // side and lifted its label out of their line.
        className="flex max-w-[160px] items-center gap-1.5 rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-left text-[0.8rem] leading-[normal] text-ink max-md:min-h-[44px]"
      >
        <span id={valueId} className="truncate">
          {accountFilterSummary(names, checked.length)}
        </span>
        <span aria-hidden="true" className="ml-auto text-[0.6rem] text-faint">
          ▼
        </span>
      </button>
      {open && (
        <div
          ref={panelRef}
          role="group"
          aria-labelledby={labelId}
          style={{ left: shift }}
          className="absolute top-full z-10 mt-1 w-64 rounded-[3px] border border-ink bg-paper p-2 text-[0.8rem] normal-case tracking-normal text-ink shadow-md"
        >
          <label className="flex cursor-pointer items-center gap-2 rounded-[2px] px-1.5 py-1 hover:bg-chip max-md:min-h-[44px]">
            <input
              type="checkbox"
              checked={checked.length === 0}
              onChange={() => setChecked([])}
              className="accent-acc"
            />
            All accounts
          </label>
          {/* Scrolls rather than growing: a panel that runs off the bottom of
              a phone is a shorter list, not a longer one. */}
          <div className="max-h-[17rem] overflow-y-auto border-t border-rule pt-1">
            {accounts.map((a) => (
              <label
                key={a.id}
                className="flex cursor-pointer items-center gap-2 rounded-[2px] px-1.5 py-1 hover:bg-chip max-md:min-h-[44px]"
              >
                <input
                  type="checkbox"
                  checked={checked.includes(a.id)}
                  onChange={() => toggle(a.id)}
                  className="accent-acc"
                />
                <span className="min-w-0">
                  <span className="block truncate">{a.name}</span>
                  <span className="block truncate text-[0.68rem] text-faint">{a.institution}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-1 flex items-center justify-between gap-3 border-t border-rule pt-1.5">
            <button
              type="button"
              onClick={() => close(true)}
              className="tap44 text-[0.72rem] text-faint hover:text-ink"
            >
              close
            </button>
            <button
              type="submit"
              className="rounded-[2px] border border-ink px-3 py-1 text-[0.8rem] hover:bg-chip max-md:min-h-[44px]"
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
