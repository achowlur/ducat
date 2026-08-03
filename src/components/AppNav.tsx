"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const TABS = [
  { label: "Overview", href: "/", built: true },
  { label: "Trends", href: "/trends", built: true },
  { label: "Insights", href: "/insights", built: true },
  { label: "Transactions", href: "/transactions", built: true },
  { label: "Accounts", href: "/accounts", built: true },
  { label: "Providers", href: "/providers", built: true },
];

export function AppNav() {
  const pathname = usePathname();
  const rail = useRef<HTMLElement | null>(null);
  const activeTab = useRef<HTMLAnchorElement | null>(null);

  // The rail scrolls at 375px and starts at scrollLeft 0, so the last three
  // tabs sat off its right edge — on /providers the active tab was 290px past
  // it. The only marker of where you are is that tab's underline, so on half
  // the app the phone reader had NOTHING telling them which tab they were on,
  // and `.scroll-x` hides the scrollbar, so nothing said more tabs existed
  // either. Bring the active tab into the rail's own scroll box.
  //
  // scrollLeft is set directly rather than via scrollIntoView, which walks
  // ancestors and would scroll the PAGE to reach a nav pinned at the top.
  useEffect(() => {
    const el = activeTab.current;
    const box = rail.current;
    if (el === null || box === null) return;
    // Measured from the RAIL, via rects. `offsetLeft` is relative to
    // `offsetParent`, and the rail is not positioned, so that origin was an
    // ancestor further up the page — the difference is this element's own left
    // inset, and it left the active tab clipped by exactly that much (17px on
    // /transactions). Rects are in one coordinate space by definition.
    const start = el.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
    const end = start + el.offsetWidth;
    if (start >= box.scrollLeft && end <= box.scrollLeft + box.clientWidth) return;
    // Centre it when there is room to, so the tabs either side stay visible
    // and the rail reads as a rail rather than as a truncated list.
    const centred = start - (box.clientWidth - el.offsetWidth) / 2;
    box.scrollLeft = Math.max(0, Math.min(centred, box.scrollWidth - box.clientWidth));
  }, [pathname]);

  return (
    // The rail scrolls itself at 375px, where six tabs need 526px. Its own
    // padding/margin pair reclaims the space the active tab's underline hangs
    // into — overflow-x also clips vertically, so without it the underline
    // (which sits on the header rule, 0.75rem+2px below the nav) disappears.
    <nav
      ref={rail}
      className="scroll-x -mt-[13px] -mb-[calc(0.75rem+2px)] flex min-w-0 gap-5 whitespace-nowrap pt-[13px] pb-[calc(0.75rem+2px)] text-[0.78rem] uppercase tracking-[0.08em]"
    >
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        if (!tab.built) {
          return (
            <span key={tab.href} className="shrink-0 cursor-default text-faint opacity-50" title="Coming in a later step">
              {tab.label}
            </span>
          );
        }
        return (
          <Link
            key={tab.href}
            href={tab.href}
            ref={active ? activeTab : undefined}
            // The active state was carried by a border colour alone, so a
            // screen reader had no way to know which tab it was on.
            aria-current={active ? "page" : undefined}
            // Padding paired with an equal negative margin: a 19px line
            // becomes a 44px hit area with no layout change. The 13/12 split
            // is what the header's own pt-5/pb-3 can absorb — any more and a
            // tab would take taps meant for the page below the rule.
            className={
              active
                ? "-mt-[13px] -mb-[calc(0.75rem+2px)] shrink-0 border-b-2 border-acc pt-[13px] pb-3 text-ink"
                : "-mt-[13px] -mb-3 shrink-0 pt-[13px] pb-3 text-faint hover:text-ink"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
