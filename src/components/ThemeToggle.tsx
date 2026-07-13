"use client";

import { useEffect, useState } from "react";

const THEMES = ["light", "dark", "sepia"] as const;
type Theme = (typeof THEMES)[number];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    setTheme(THEMES.includes(current as Theme) ? (current as Theme) : "sepia");
  }, []);

  const apply = (next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage unavailable (private mode) — theme still applies for this page
    }
    setTheme(next);
  };

  return (
    <span className="inline-flex gap-1">
      {THEMES.map((t) => (
        <button
          key={t}
          onClick={() => apply(t)}
          className={`rounded-sm border px-2 py-0.5 text-[0.68rem] uppercase tracking-[0.06em] ${
            theme === t ? "border-ink text-ink" : "border-rule text-faint hover:text-ink"
          }`}
        >
          {t}
        </button>
      ))}
    </span>
  );
}
