import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { AppNav } from "../components/AppNav";
import { ThemeToggle } from "../components/ThemeToggle";
import { isAuthEnabled, isCloudMode } from "../lib/auth/mode";
import { logout } from "./login/actions";

export const metadata: Metadata = {
  title: "Finance · Local",
  description: "Local-only personal finance tracker",
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

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="antialiased">
        <div className="mx-auto min-h-screen max-w-6xl px-6">
          {onLogin ? null : (
            <header className="flex items-baseline justify-between gap-6 border-b-2 border-ink pb-3 pt-5">
              <span className="text-[0.8rem] font-semibold uppercase tracking-[0.14em]">
                Finance · Local
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
        </div>
      </body>
    </html>
  );
}
