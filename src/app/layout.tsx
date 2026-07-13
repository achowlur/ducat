import type { Metadata } from "next";
import "./globals.css";
import { AppNav } from "../components/AppNav";
import { ThemeToggle } from "../components/ThemeToggle";

export const metadata: Metadata = {
  title: "Finance · Local",
  description: "Local-only personal finance tracker",
};

// Applied before paint so the persisted theme never flashes.
const themeInit = `try{document.documentElement.dataset.theme=localStorage.getItem('theme')||'sepia'}catch(e){document.documentElement.dataset.theme='sepia'}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="antialiased">
        <div className="mx-auto min-h-screen max-w-6xl px-6">
          <header className="flex items-baseline justify-between gap-6 border-b-2 border-ink pb-3 pt-5">
            <span className="text-[0.8rem] font-semibold uppercase tracking-[0.14em]">
              Finance · Local
            </span>
            <AppNav />
            <span className="hidden items-baseline gap-4 text-[0.75rem] text-faint sm:flex">
              <span className="font-money">127.0.0.1</span>
              <ThemeToggle />
            </span>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
