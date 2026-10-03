"use client";

import Link from "next/link";
import { createContext, useContext, useTransition, type ReactNode, type TransitionStartFunction } from "react";
import { SectionTitle } from "../ui/headings";

interface CardTransitionValue {
  pending: boolean;
  start: TransitionStartFunction;
}

const CardTransition = createContext<CardTransitionValue | null>(null);

/**
 * The transition of the card a control sits in. A control that re-asks the
 * server runs inside it, so the card being changed dims until its new answer
 * lands: on Turso that is a visible wait, and a figure that sits unchanged
 * after a choice reads as the choice having done nothing.
 */
export function useCardTransition(): CardTransitionValue | null {
  return useContext(CardTransition);
}

/**
 * One /trends card, in Overview's order: the caption with the chart choice
 * beside it, the controls that change the question, then the answer. Full
 * width at every size, like every /trends block since the proportion pass.
 */
export function CardFrame({
  id,
  title,
  switcher,
  controls,
  children,
}: {
  /** An anchor another page can link straight to. */
  id?: string;
  title: string;
  switcher: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <section id={id} className="min-w-0 scroll-mt-4" aria-busy={pending}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <SectionTitle>{title}</SectionTitle>
        {switcher}
      </div>
      <CardTransition.Provider value={{ pending, start: startTransition }}>
        {controls !== undefined && <div className="mb-4 flex flex-wrap items-end gap-x-3 gap-y-2">{controls}</div>}
      </CardTransition.Provider>
      <div className={`transition-opacity duration-150 ${pending ? "opacity-50" : ""}`}>{children}</div>
    </section>
  );
}

/**
 * The card's answer as Ducat states one: a single figure in the money face,
 * the size of Overview's band figures, and a faint line of context under it
 * carrying the label and the figures it is measured against.
 */
export function Hero({
  figure,
  tone,
  children,
}: {
  figure: ReactNode;
  tone?: "pos" | "neg";
  children?: ReactNode;
}) {
  return (
    <div className="mb-4">
      <div
        className={`font-money text-[1.25rem] leading-tight tabular ${
          tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : ""
        }`}
      >
        {figure}
      </div>
      {children !== undefined && <p className="mt-1 max-w-[760px] text-[0.78rem] leading-relaxed text-faint">{children}</p>}
    </div>
  );
}

/** What a context line is ABOUT: "September 2026", "Oct 3". */
export function Lead({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-ink">{children}</span>;
}

/** A figure inside a context line. */
export function Fig({ children, tone }: { children: ReactNode; tone?: "pos" | "neg" }) {
  return (
    <span
      className={`whitespace-nowrap font-money font-semibold tabular ${
        tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : "text-ink"
      }`}
    >
      {children}
    </span>
  );
}

/** The small print a figure owes its reader: coverage gaps, what is left out. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-2 max-w-[760px] text-[0.72rem] leading-relaxed text-faint">{children}</p>;
}

/** A card's way onward, in the voice of Overview's "full breakdown →". */
export function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="tap44 mt-2 inline-block text-[0.72rem] uppercase tracking-[0.08em] text-acc hover:underline"
    >
      {children} →
    </Link>
  );
}

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}
