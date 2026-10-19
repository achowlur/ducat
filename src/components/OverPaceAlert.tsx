import Link from "next/link";
import { overPace, type Pace } from "../lib/insights/pace";
import { ActionAlert, ALERT_ACTION } from "./ActionAlert";

/** Where "See where" lands: /trends' comparison of this month so far, on spending. */
export const OVER_PACE_HREF = "/trends?b.span=mtd&b.show=spending&b.by=category#what-changed";

/** A whole-dollar estimate: a pace figure's cents are noise. */
const dollars = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * The sentence the alert says, from overPace's answer. Exported so the tests
 * pin the words per case without rendering.
 */
export function overPaceSentence(pace: Pace, month: string): string | null {
  const o = overPace(pace);
  if (o === null) return null;
  if (o.kind === "past") return `Already ${dollars(o.over)} over a typical month`;
  if (o.kind === "committed") return `Recurring charges still due put ${month} ${dollars(o.over)} over a typical month`;
  return o.daysLeft === 1
    ? `Keep to ~${dollars(o.perDay)} today to land inside a typical month`
    : `Keep to ~${dollars(o.perDay)}/day for the rest of ${month} to land inside a typical month`;
}

/**
 * The month being lived in is projected ABOVE the typical range: what to do
 * about it. Shown on /insights under the month's headline and on /trends' This
 * month so far, from the same overPace function. Silent when the month is not
 * over, when the pace call refused, and for any month but the current one
 * (`pace` is null there).
 */
export function OverPaceAlert({ pace, month }: { pace: Pace | null; month: string }) {
  const sentence = pace === null ? null : overPaceSentence(pace, month);
  if (sentence === null) return null;
  return (
    <ActionAlert
      kind="Over pace"
      actions={
        <Link className={ALERT_ACTION} href={OVER_PACE_HREF}>
          See where
        </Link>
      }
    >
      {sentence}
    </ActionAlert>
  );
}
