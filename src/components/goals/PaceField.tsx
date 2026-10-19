"use client";

import { useState } from "react";

const wholeDollars = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const FIELD =
  "tap44 w-[9.5rem] rounded-[2px] border border-rule bg-paper px-1.5 py-0.5 font-money text-[0.85rem] tabular text-ink outline-none focus:border-acc";

/**
 * The goal card's "Saved per month" field, in the net worth goal's shape: a
 * dollar field that commits on Enter or on leaving it and puts back what it
 * showed on Escape or a refused value. Two differences, both because a
 * SUGGESTION can sit in it: leaving a field nobody edited saves nothing (a tap
 * through it must not accept the figure shown), while Enter always commits,
 * and every keystroke is reported (`onDraft`) so the card can re-project its
 * date while the figure is being typed. The caller keys it by the value it
 * shows, so a figure that moved elsewhere redraws.
 */
export function PaceField({
  id,
  value,
  onDraft,
  onCommit,
}: {
  id: string;
  value: number;
  /** The figure as typed so far, or null while it cannot be read. */
  onDraft: (typed: number | null) => void;
  /** False refuses the value and puts back the one shown. */
  onCommit: (typed: number | null) => boolean;
}) {
  const [draft, setDraft] = useState(wholeDollars.format(value));
  const [touched, setTouched] = useState(false);
  const read = (text: string): number | null => {
    const cleaned = text.replace(/[^0-9.-]/g, "");
    const typed = Number(cleaned);
    return cleaned === "" || cleaned === "-" || !Number.isFinite(typed) ? null : typed;
  };
  const commit = () => {
    const typed = read(draft);
    const ok = onCommit(typed);
    setTouched(false);
    setDraft(wholeDollars.format(ok && typed !== null ? typed : value));
    if (!ok) onDraft(null);
  };
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="font-money">$</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setTouched(true);
          onDraft(read(e.target.value));
        }}
        onBlur={() => {
          if (touched) commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(wholeDollars.format(value));
            setTouched(false);
            onDraft(null);
          }
        }}
        className={FIELD}
      />
    </span>
  );
}
