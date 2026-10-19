import { CHIP, CONTROL } from "./ui/headings";

/** The class for an ActionAlert's controls: a real, 44px-tall button or link. */
export const ALERT_ACTION = `${CONTROL} tap44 inline-flex items-center border-ink bg-paper font-semibold`;

/**
 * One grammar for every nudge that asks the reader to ACT (agreed with the
 * operator 2026-10-19): a warn rule, a warn status chip naming the KIND of
 * alert, the sentence in bold, an optional faint detail line, and the action
 * as a real control. `lead` is the larger form for "Do this next". A recap or a
 * fact is never an ActionAlert: only what asks for an action wears it.
 */
export function ActionAlert({
  kind,
  children,
  detail,
  actions,
  lead = false,
}: {
  kind: string;
  children: React.ReactNode;
  detail?: React.ReactNode;
  actions?: React.ReactNode;
  lead?: boolean;
}) {
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-l-4 border-warn bg-chip ${
        lead ? "px-4 py-3" : "px-3 py-2.5"
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className={`${lead ? "text-[0.98rem]" : "text-[0.88rem]"} font-semibold leading-snug`}>
          <span className={`${CHIP} mr-2 align-[2px] bg-warn text-on-warn`}>{kind}</span>
          {children}
        </p>
        {detail !== undefined && <p className="mt-1 text-[0.78rem] leading-relaxed text-faint">{detail}</p>}
      </div>
      {actions !== undefined && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
