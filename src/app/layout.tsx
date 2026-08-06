import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { AppNav } from "../components/AppNav";
import { ThemeToggle } from "../components/ThemeToggle";
import { isAuthEnabled, isCloudMode } from "../lib/auth/mode";
import { logout } from "./login/actions";

export const metadata: Metadata = {
  title: "Ducat",
  description: "Local-first personal finance tracker",
};

// Applied before paint so the persisted theme never flashes.
const themeInit = `try{document.documentElement.dataset.theme=localStorage.getItem('theme')||'sepia'}catch(e){document.documentElement.dataset.theme='sepia'}`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Set by middleware; used only to drop the app chrome on the login screen.
  const onLogin = (await headers()).get("x-app-path") === "/login";
  // When the gate is on, every non-login page implies an authenticated session
  // (middleware guarantees it), so a Lock control is safe to show there.
  const showLock = isAuthEnabled() && !onLogin;
  const modeBadge = isCloudMode() ? "cloud" : "127.0.0.1";

  // `data-auth` on <html> publishes whether a password gate EXISTS, for the
  // error boundary — a client component that cannot call isAuthEnabled()
  // itself. Same channel the theme already uses. It leaks nothing: the login
  // screen announces the gate to anyone who loads the app.
  return (
    <html lang="en" data-auth={isAuthEnabled() ? "on" : "off"} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="antialiased">
        <div className="mx-auto min-h-screen max-w-6xl px-6">
          {onLogin ? null : (
            <header className="flex items-baseline justify-between gap-6 border-b-2 border-ink pb-3 pt-5">
              <span className="text-[0.8rem] font-semibold uppercase tracking-[0.14em]">
                Ducat
              </span>
              <AppNav />
              <span className="hidden items-baseline gap-4 text-[0.75rem] text-faint sm:flex">
                <span className="font-money">{modeBadge}</span>
                <ThemeToggle />
                {showLock ? (
                  <form action={logout}>
                    <button type="submit" className="uppercase tracking-[0.1em] text-faint hover:text-ink">
                      Lock
                    </button>
                  </form>
                ) : null}
              </span>
            </header>
          )}
          <main>{children}</main>
          {/* The header's right-hand cluster is `hidden sm:flex`, so below
              640px there was no way to LOCK the app or change theme at all —
              on the deployment, which DEPLOY.md calls "the one on your phone".
              It cannot simply be revealed: at 375px the three theme buttons
              plus Lock leave the six-tab nav about 107px of the 327px content
              width, and the nav already scrolls at 526px.

              So the same controls get a mobile-only footer instead. A footer
              keeps the header's calibrated geometry untouched — the active
              tab's underline sits on the header rule through a negative margin
              pair, and a second header row would have pulled the nav's 13px
              hit area up into whatever landed above it, which is the
              overlapping-targets failure the 44px pass was careful to avoid. */}
          {onLogin ? null : (
            <footer className="mt-10 flex items-center justify-between gap-4 border-t border-rule py-4 text-[0.75rem] text-faint sm:hidden">
              <span className="font-money">{modeBadge}</span>
              <span className="flex items-center gap-4">
                <ThemeToggle />
                {showLock ? (
                  <form action={logout}>
                    <button
                      type="submit"
                      className="min-h-[44px] px-2 uppercase tracking-[0.1em] text-faint hover:text-ink"
                    >
                      Lock
                    </button>
                  </form>
                ) : null}
              </span>
            </footer>
          )}
        </div>
      </body>
    </html>
  );
}
