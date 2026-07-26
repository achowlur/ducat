"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
  return (
    // The rail scrolls itself at 375px, where six tabs need 526px. Its own
    // padding/margin pair reclaims the space the active tab's underline hangs
    // into — overflow-x also clips vertically, so without it the underline
    // (which sits on the header rule, 0.75rem+2px below the nav) disappears.
    <nav className="scroll-x -mb-[calc(0.75rem+2px)] flex min-w-0 gap-5 whitespace-nowrap pb-[calc(0.75rem+2px)] text-[0.78rem] uppercase tracking-[0.08em]">
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
            className={
              active
                ? "-mb-[calc(0.75rem+2px)] shrink-0 border-b-2 border-acc pb-3 text-ink"
                : "shrink-0 text-faint hover:text-ink"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
