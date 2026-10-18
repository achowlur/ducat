import { SectionTitle } from "./ui/headings";
import { dateTime, shortDate } from "../lib/ui/format";
import {
  countedPartway,
  GITHUB_PRIVATE_ACTIONS_MINUTES,
  LIMITS_CHECKED,
  SIMPLEFIN_DAILY_REQUESTS,
  TURSO_FREE,
  VERCEL_HOBBY,
  type UsageLine,
  type UsageReading,
} from "../lib/usage/limits";

const WARN_TEXT = "text-[color:var(--warn-ink)]";

/** "1,234" under ten thousand, then "41.2k", "12.3M", "500M". */
export function countLabel(n: number): string {
  const compact = (value: number, unit: string) => {
    const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
    return `${fixed}${unit}`;
  };
  if (n >= 1_000_000_000) return compact(n / 1_000_000_000, "B");
  if (n >= 1_000_000) return compact(n / 1_000_000, "M");
  if (n >= 10_000) return compact(n / 1_000, "k");
  return n.toLocaleString("en-US");
}

/** A share of an allowance: "0%", "<0.1%", "2.4%", "37%". */
export function shareLabel(share: number): string {
  if (share === 0) return "0%";
  if (share < 0.001) return "<0.1%";
  if (share < 0.1) return `${(share * 100).toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(share * 100)}%`;
}

function UsageRow({ line }: { line: UsageLine }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-rule py-1.5 last:border-b-0">
      <span className="text-[0.85rem]">
        {line.service} <span className="text-faint">{line.label}</span>
      </span>
      <span className={`font-money text-[0.8rem] tabular ${line.warn ? `font-semibold ${WARN_TEXT}` : ""}`}>
        {countLabel(line.used)} of {countLabel(line.limit)} · {shareLabel(line.share)}
        {line.paceShare !== null && <> · on pace for {shareLabel(line.paceShare)}</>}
      </span>
    </li>
  );
}

/**
 * /providers' account of the hosts' free-plan limits: what this instance has
 * spent this month against each, counted by the app itself (lib/usage/meter.ts).
 *
 * In view: one row per allowance, any warning, and anything that makes a
 * figure smaller than the truth. How it is counted, and the limits nothing
 * here can measure, fold behind a tap.
 */
export function UsageLimits({
  cloud,
  reading,
  lines,
}: {
  cloud: boolean;
  reading: UsageReading | null;
  lines: UsageLine[];
}) {
  if (!cloud) {
    return (
      <section>
        <SectionTitle>Free-plan limits</SectionTitle>
        <p className="text-[0.82rem] leading-relaxed">
          Local mode spends no Turso or Vercel allowance. SimpleFIN expects {SIMPLEFIN_DAILY_REQUESTS} requests a day
          or fewer, and a sync makes one.
        </p>
      </section>
    );
  }
  if (reading === null) {
    return (
      <section>
        <SectionTitle>Free-plan limits</SectionTitle>
        <p className={`text-[0.82rem] leading-relaxed ${WARN_TEXT}`}>
          Usage is not being counted: this database has no UsageCount table yet. Run{" "}
          <code className="font-money">npm run schema:push</code> against it.
        </p>
      </section>
    );
  }

  const statements = reading.monthly["turso.statements"] ?? 0;
  const unreported = reading.monthly["turso.unreported"] ?? 0;
  const passing = lines.filter((l) => l.paceShare !== null && l.paceShare >= 1);

  return (
    <section>
      <SectionTitle>Free-plan limits</SectionTitle>
      <ul className="grid">
        {lines.map((l) => (
          <UsageRow key={`${l.service} ${l.label}`} line={l} />
        ))}
        <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
          <span className="text-[0.85rem]">
            GitHub <span className="text-faint">Actions</span>
          </span>
          <span className="text-[0.8rem] text-faint">
            unmetered on a public repository; {GITHUB_PRIVATE_ACTIONS_MINUTES.toLocaleString("en-US")} min a month if
            private
          </span>
        </li>
      </ul>

      {passing.map((l) => (
        <p key={`pace ${l.service} ${l.label}`} className={`pt-1.5 text-[0.78rem] leading-relaxed ${WARN_TEXT}`}>
          At this month&apos;s rate, {l.service} {l.label} pass the free limit before the month ends.
        </p>
      ))}
      {unreported > 0 && (
        <p className={`pt-1.5 text-[0.78rem] leading-relaxed ${WARN_TEXT}`}>
          Turso did not report row counts for {countLabel(unreported)} of {countLabel(statements)} statements, so the
          Turso figures are low by whatever those read.
        </p>
      )}
      {reading.countedSince !== null && countedPartway(reading) && (
        <p className="pt-1.5 text-[0.78rem] leading-relaxed text-faint">
          Counted since {dateTime(reading.countedSince)}: anything earlier this month is not in these figures.
        </p>
      )}
      <p className="pt-1.5 text-[0.78rem] leading-relaxed text-faint">
        Each host&apos;s free plan, as published on {shortDate(new Date(`${LIMITS_CHECKED}T00:00:00Z`))}. Turso&apos;s
        cover every database on the account, and this counts only this one.
      </p>

      <details className="group pt-1 text-[0.78rem] text-faint">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 max-md:min-h-[44px] [&::-webkit-details-marker]:hidden">
          How this is counted
          <span aria-hidden="true" className="text-[0.7rem] transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="grid gap-1.5 pt-1.5 leading-relaxed">
          <p>
            Rows read and written are Turso&apos;s own figures: it reports both on every statement, and the app adds
            them up. That covers every page, the nightly job, the nightly backup and commands run through the
            app&apos;s connection; schema:push and turso:push open their own and are not counted. Turso also allows{" "}
            {TURSO_FREE.storageGb} GB of storage, not measured here.
          </p>
          <p>
            Requests served counts pages and the nightly job. Vercel also counts sign-ins and every file it serves
            (edge requests, 1M a month), {VERCEL_HOBBY.activeCpuHours} hours of CPU and {VERCEL_HOBBY.transferGb} GB of
            transfer, which only its Usage page shows.
          </p>
          <p>
            SimpleFIN expects {SIMPLEFIN_DAILY_REQUESTS} requests a day or fewer and disables a token that keeps going
            past it. A sync makes one, or two when it reaches back more than 30 days. Days here are UTC days; the
            busiest this month made {reading.simplefinBusiestDay}.
          </p>
          <p>
            The pace projects this month&apos;s rate to its end, once a day has been counted.
          </p>
        </div>
      </details>
    </section>
  );
}
