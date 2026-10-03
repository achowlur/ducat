"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useCardTransition } from "./CardFrame";

export interface SelectOption {
  value: string;
  label: string;
  /** Options sharing a group render under one <optgroup>. */
  group?: string;
}

/**
 * One of a card's question controls. A change re-asks the server for the
 * page (the figures are computed there, from every transaction) WITHOUT
 * scrolling: these sit halfway down a long page, and a navigation that
 * jumped to the top would lose the card being asked about. The parameter is
 * dropped when it returns to its default, so a plain /trends stays plain.
 *
 * It runs in its CARD's transition, which dims that card until the answer
 * lands, and every control in the card waits meanwhile: the URL only updates
 * when the navigation commits, so a second change made mid-flight would be
 * built on the old query and silently undo the first.
 */
export function ReportSelect({
  name,
  label,
  value,
  fallback,
  options,
}: {
  name: string;
  label: string;
  value: string;
  /** The value that needs no parameter. */
  fallback: string;
  options: SelectOption[];
}) {
  const router = useRouter();
  const [ownPending, ownStart] = useTransition();
  const card = useCardTransition();
  const pending = card?.pending ?? ownPending;
  const startTransition = card?.start ?? ownStart;
  const groups: { name: string | undefined; options: SelectOption[] }[] = [];
  for (const o of options) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.name === o.group) last.options.push(o);
    else groups.push({ name: o.group, options: [o] });
  }
  const render = (o: SelectOption) => (
    <option key={o.value} value={o.value}>
      {o.label}
    </option>
  );
  return (
    <label className="grid gap-0.5 text-[0.68rem] uppercase tracking-[0.1em] text-faint">
      {label}
      <select
        name={name}
        value={value}
        disabled={pending}
        onChange={(e) => {
          const params = new URLSearchParams(window.location.search);
          if (e.target.value === fallback) params.delete(name);
          else params.set(name, e.target.value);
          const qs = params.toString();
          startTransition(() => router.replace(qs === "" ? "/trends" : `/trends?${qs}`, { scroll: false }));
        }}
        className="rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] normal-case tracking-normal text-ink disabled:opacity-60 max-md:min-h-[44px]"
      >
        {groups.map((g, i) =>
          g.name === undefined ? (
            g.options.map(render)
          ) : (
            <optgroup key={`${g.name}-${i}`} label={g.name}>
              {g.options.map(render)}
            </optgroup>
          ),
        )}
      </select>
    </label>
  );
}
