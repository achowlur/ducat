/**
 * A figure and the line that explains it, as Ducat states one: the money face
 * for the figure, a faint context line under it naming what it is ABOUT and
 * the figures it is measured against. Server-safe, so a page can lead with one
 * as well as a /trends card.
 */
import type { ReactNode } from "react";

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
