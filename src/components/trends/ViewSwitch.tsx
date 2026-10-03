"use client";

import { useState } from "react";

export interface ViewOption<T extends string> {
  value: T;
  label: string;
}

/**
 * The card's chosen chart, kept three ways: in state, so switching is instant
 * (every view's figures are already on the page); in the URL, so a link
 * carries it; and in a cookie, so the card opens on it next time. The server
 * reads the last two (lib/ui/trendsParams.ts) and hands the result back as
 * `initial`, validated against the views the card's data can be drawn as.
 */
export function useCardView<T extends string>(card: string, initial: T): [T, (v: T) => void] {
  const [view, setView] = useState<T>(initial);
  // A new data shape can make the remembered view invalid; the server then
  // sends a different `initial`, and that wins.
  const [anchor, setAnchor] = useState<T>(initial);
  if (anchor !== initial) {
    setAnchor(initial);
    setView(initial);
  }
  const choose = (v: T) => {
    setView(v);
    try {
      const secure = window.location.protocol === "https:" ? "; secure" : "";
      document.cookie = `trends.${card}=${v}; path=/; max-age=31536000; samesite=lax${secure}`;
    } catch {
      // A blocked cookie costs the memory, never the switch.
    }
    const url = new URL(window.location.href);
    url.searchParams.set(`${card}.view`, v);
    window.history.replaceState(null, "", url.pathname + url.search);
  };
  return [view, choose];
}

/**
 * "View as": the charts this card's data can honestly be drawn as. The list
 * comes from the data's SHAPE, so a pie is never offered for months.
 */
export function ViewSwitch<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ViewOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  // Drawn as the header's theme switch is: the chosen one carries an ink
  // border, the rest a rule. A solid fill made this the heaviest control in
  // the app, louder than the figures it only changes the drawing of.
  return (
    <div role="group" aria-label="View as" className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-[0.68rem] uppercase tracking-[0.1em] text-faint">View as</span>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`tap44 rounded-sm border px-2 py-0.5 text-[0.68rem] uppercase tracking-[0.06em] ${
              active ? "border-ink text-ink" : "border-rule text-faint hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
