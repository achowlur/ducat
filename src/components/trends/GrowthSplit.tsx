import { money } from "../../lib/ui/format";
import { wholePercents } from "../../lib/ui/spendingBreakdown";

/**
 * Saved against markets: the two colours the By year bars use, named once
 * each. A swatch carries identity; the words beside it stay in ink.
 */
export function Swatch({ part }: { part: "saved" | "markets" }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-[9px] w-[9px] shrink-0 rounded-[2px] ${part === "saved" ? "bg-chart1" : "bg-chart2"}`}
    />
  );
}

/**
 * What a span's growth was made of, as one bar split in proportion with its
 * two parts named beneath it: the labels ARE the legend, so no figure is
 * printed twice. A share of a whole is drawn only when both parts grew; when
 * one shrank there is no whole to divide, and the two figures stand alone.
 */
export function GrowthSplit({ saved, markets, joined = 0 }: { saved: number; markets: number; joined?: number }) {
  const both = saved > 0 && markets > 0;
  const [savedShare, marketShare] = both ? wholePercents([saved / (saved + markets), markets / (saved + markets)]) : [null, null];
  return (
    <div className="mb-5 max-w-[560px]">
      {both && (
        <div className="mb-2 flex h-2.5 gap-[2px]" aria-hidden>
          <div className="rounded-l-[4px] bg-chart1" style={{ flexGrow: saved }} />
          <div className="rounded-r-[4px] bg-chart2" style={{ flexGrow: markets }} />
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[0.78rem] text-faint">
        <span className="inline-flex items-center gap-1.5">
          <Swatch part="saved" />
          Saved <span className={`font-money font-semibold tabular ${saved < 0 ? "text-neg" : "text-ink"}`}>{money(saved)}</span>
          {savedShare !== null && <span>{savedShare}%</span>}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Swatch part="markets" />
          Markets <span className={`font-money font-semibold tabular ${markets < 0 ? "text-neg" : "text-ink"}`}>{money(markets)}</span>
          {marketShare !== null && <span>{marketShare}%</span>}
        </span>
      </div>
      {/* An account joining the total brings its whole balance: part of the
          change, and neither saved nor markets, so it is named apart. */}
      {Math.abs(joined) >= 0.5 && (
        <p className="pt-1 text-[0.78rem] text-faint">
          The rest, <span className="font-money tabular text-ink">{money(Math.abs(joined))}</span>, is accounts{" "}
          {joined > 0 ? "joining" : "leaving"} the total, not saving.
        </p>
      )}
    </div>
  );
}
