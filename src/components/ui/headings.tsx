/**
 * The page and section headings, defined ONCE.
 *
 * The six tabs had four different answers to "what is a section heading":
 * `<h3>` at 0.72rem/0.14em on Overview, Trends and Insights (three separate
 * local copies of the same function), `<h4>` at 0.68rem/0.13em on Providers,
 * a styled non-heading element on Accounts, and nothing at all on
 * Transactions. Sighted readers never saw the difference; a screen reader got
 * a document whose outline changed shape per tab.
 *
 * And no tab had an `<h1>`: the only ones in the app were on the login screen
 * and the error boundary, so every page began its outline at level 3 or 4
 * under nothing. The tab name is carried by the nav's active state, which is
 * a visual affordance rather than a heading, so the title here is
 * visually-hidden — it costs no pixels and gives the outline a root.
 */
export function PageTitle({ children }: { children: React.ReactNode }) {
  return <h1 className="sr-only">{children}</h1>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2.5 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
      {children}
    </h2>
  );
}

/** A heading INSIDE a section — /providers' per-connector parts. */
export function SubsectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.13em] text-faint">
      {children}
    </h3>
  );
}
