"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Overview", href: "/", built: true },
  { label: "Trends", href: "/trends", built: true },
  { label: "Insights", href: "/insights", built: true },
  { label: "Transactions", href: "/transactions", built: true },
  { label: "Accounts", href: "/accounts", built: true },
  { label: "Providers", href: "/providers", built: false },
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-5 text-[0.78rem] uppercase tracking-[0.08em]">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        if (!tab.built) {
          return (
            <span key={tab.href} className="cursor-default text-faint opacity-50" title="Coming in a later step">
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
                ? "-mb-[calc(0.75rem+2px)] border-b-2 border-acc pb-3 text-ink"
                : "text-faint hover:text-ink"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
