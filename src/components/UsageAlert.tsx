import Link from "next/link";
import { isCloudMode } from "../lib/auth/mode";
import { prisma } from "../lib/prisma";
import { shortDate } from "../lib/ui/format";
import { readUsageCached, usageLines, usageResetsOn, type UsageLine, type UsageReading } from "../lib/usage/limits";
import { countLabel, shareLabel } from "./UsageLimits";

/** What happens past each host's limit, in one sentence. */
const CONSEQUENCE: Record<UsageLine["service"], string> = {
  Turso: "Past it, Turso blocks every database on the account until the month resets, and every page here fails.",
  Vercel: "Past it, Vercel stops serving this instance until its allowance resets.",
  SimpleFIN: "Past it, SimpleFIN may disable the access token, and syncing stops until a new one is claimed.",
};

function sentence(line: UsageLine, reading: UsageReading): string {
  if (line.service === "SimpleFIN") {
    return `SimpleFIN requests: the busiest day this month made ${Math.max(line.used, reading.simplefinBusiestDay)} of the ${line.limit} a day it allows.`;
  }
  const pace =
    line.paceShare !== null && line.paceShare > line.share
      ? `, on pace for ${shareLabel(line.paceShare)} by ${shortDate(usageResetsOn(reading))}`
      : "";
  return `${line.service} ${line.label}: ${countLabel(line.used)} of the free plan's ${countLabel(line.limit)} this month (${shareLabel(line.share)})${pace}.`;
}

/** The banner itself, given a reading: pure, so it can be tested without a database. */
export function UsageAlertBanner({ reading, now }: { reading: UsageReading; now: Date }) {
  const urgent = usageLines(reading, now).filter((l) => l.warn);
  if (urgent.length === 0) return null;
  const services = [...new Set(urgent.map((l) => l.service))];
  return (
    <div role="alert" className="mt-3 bg-warn px-4 py-3 text-on-warn">
      <p className="text-[0.95rem] font-bold">Close to a free-plan limit</p>
      <ul className="mt-1 grid gap-0.5 text-[0.85rem] leading-relaxed">
        {urgent.map((l) => (
          <li key={`${l.service} ${l.label}`}>{sentence(l, reading)}</li>
        ))}
      </ul>
      <p className="mt-1 text-[0.8rem] leading-relaxed">{services.map((s) => CONSEQUENCE[s]).join(" ")}</p>
      <Link href="/providers" className="tap44 mt-1 inline-flex items-center text-[0.8rem] font-semibold underline">
        Details on Providers
      </Link>
    </div>
  );
}

/**
 * The alert every page carries when an allowance is close to its free limit:
 * at 80% used, or on pace to pass it before the month ends (usageLines' warn).
 * It lives in the root layout, so it shows above whatever page is open.
 *
 * Cloud mode only, read through a ten-minute cache so it costs no round trip on
 * most pages, and silent on any failure: a page whose database is unreachable
 * already says so, and the banner must never be what breaks a page.
 */
export async function UsageAlert() {
  if (!isCloudMode()) return null;
  const now = new Date();
  let reading: UsageReading | null;
  try {
    reading = await readUsageCached(prisma, now);
  } catch {
    return null;
  }
  return reading === null ? null : <UsageAlertBanner reading={reading} now={now} />;
}
