import Link from "next/link";
import { money } from "../lib/ui/format";
import type { MonthRecap as Recap } from "../lib/ui/monthRecap";
import { FIELD_LABEL, SubsectionTitle } from "./ui/headings";

/** A nudge still open, as the review panel lists it. */
export interface OpenNudge {
  text: string;
  href?: string;
}

const signed = (n: number) => `${n > 0 ? "+" : ""}${money(n)}`;

function Figure({ label, figure, sub, tone }: { label: string; figure: string; sub: string; tone?: "pos" | "neg" }) {
  return (
    <div className="min-w-0">
      <div className={FIELD_LABEL}>{label}</div>
      <div className={`font-money text-[1.1rem] tabular ${tone === "pos" ? "text-pos" : tone === "neg" ? "text-neg" : ""}`}>
        {figure}
      </div>
      {sub !== "" && <div className="mt-0.5 text-[0.72rem] text-faint">{sub}</div>}
    </div>
  );
}

/**
 * The month that just closed, on days 1 to 7 only. A recap, not an alert: it
 * asks for nothing. Each figure is another screen's own (ui/monthRecap.ts),
 * and one that has no record says so in words instead of printing zero.
 */
export function MonthRecap({ recap, nudges }: { recap: Recap; nudges: OpenNudge[] }) {
  const { spent, netWorth, goal, moved, monthName } = recap;
  const spentSub =
    spent === null
      ? ""
      : [
          spent.vsTypical === null
            ? "no typical month to compare yet"
            : Math.round(Math.abs(spent.vsTypical)) === 0
              ? "in line with typical"
              : `${money(Math.abs(spent.vsTypical))} ${spent.vsTypical < 0 ? "under" : "over"} typical`,
          spent.caveat,
        ]
          .filter((s) => s !== null)
          .join(" · ");
  const netWorthSub =
    netWorth === null
      ? ""
      : [
          `saved ${money(netWorth.saved)}`,
          `markets ${money(netWorth.markets)}`,
          netWorth.joined !== 0 ? `joined ${money(netWorth.joined)}` : null,
          netWorth.caveat,
        ]
          .filter((s) => s !== null)
          .join(" · ");
  const nothing = spent === null && netWorth === null && goal === null;

  return (
    <section className="mt-5 border-y border-rule py-3" aria-label={`${monthName} recap`}>
      <SubsectionTitle>{monthName} recap</SubsectionTitle>
      {nothing ? (
        <p className="text-[0.85rem] text-faint">Nothing recorded for {monthName}.</p>
      ) : (
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 min-[480px]:grid-cols-3">
          {spent === null ? (
            <Figure label="Spent" figure="No record" sub={`nothing recorded for ${monthName}`} />
          ) : (
            <Figure label="Spent" figure={money(spent.total)} sub={spentSub} />
          )}
          {netWorth === null ? (
            <Figure label="Net worth" figure="No record" sub={`${monthName} or the month before has no net worth`} />
          ) : (
            <Figure
              label="Net worth"
              figure={signed(netWorth.change)}
              sub={netWorthSub}
              tone={netWorth.change > 0 ? "pos" : netWorth.change < 0 ? "neg" : undefined}
            />
          )}
          {goal !== null && (
            <Figure label={goal.name} figure={goal.lands ?? "No date"} sub={goal.sub} />
          )}
        </div>
      )}
      <details className="group">
        <summary className="tap44 mt-1 inline-flex cursor-pointer list-none items-center gap-1.5 text-[0.75rem] text-acc hover:underline [&::-webkit-details-marker]:hidden">
          What else moved
          <span aria-hidden="true" className="text-[0.7rem] transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="grid max-w-[60ch] gap-1.5 pb-1 text-[0.8rem]">
          <p>
            {moved === null ? (
              <span className="text-faint">No category ran far over typical.</span>
            ) : (
              <>
                <span className="font-semibold">{moved.category}</span>{" "}
                <span className="font-money tabular">{money(moved.spending)}</span>
                <span className="text-faint">
                  , {money(moved.over)} over a typical {money(moved.typical)}
                </span>
              </>
            )}
          </p>
          {nudges.length === 0 ? (
            <p className="text-faint">Nothing is waiting on you.</p>
          ) : (
            <ul className="grid gap-1">
              {nudges.map((n) => (
                <li key={n.text}>
                  {n.href === undefined ? (
                    <span>{n.text}</span>
                  ) : (
                    <Link href={n.href} className="tap44 inline-flex items-center text-acc hover:underline">
                      {n.text} →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
}
