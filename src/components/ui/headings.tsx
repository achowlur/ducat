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

/*
 * One look per ROLE (2026-10-04). Section headings, subsection headings and
 * column headers were all the same faint tracked caps, ~55 of them on
 * /insights alone, so nothing on a page outranked anything else and a column
 * label read as loudly as the section it sat in. Now a section heading LEADS,
 * bold in ink at 0.95rem (a first pass at 0.85rem semibold sat too close to
 * the old look for the operator to see any difference); a subsection keeps
 * the old faint caps one step down; a column header is faint sentence case
 * with no tracking, the quietest of the three. Chips keep their small caps, the one place they earn it.
 */
export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-[0.95rem] font-bold uppercase tracking-[0.08em] text-ink">
      {children}
    </h2>
  );
}

/** A heading INSIDE a section — /providers' per-connector parts. */
export function SubsectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-faint">
      {children}
    </h3>
  );
}

/**
 * Every `th scope="col"`'s type, so a column header can never again be
 * mistaken for a heading. Layout (padding, alignment, width) stays per table.
 */
export const COLUMN_HEADER = "text-[0.7rem] font-semibold text-faint";

/*
 * The other three roles (2026-10-04, second pass). After the headings led,
 * every button (RULE, LINK, DISMISS, FILTER) and every form label still wore
 * the faint tracked caps a caption wears, so a control a thumb must find read
 * as a label, and a label read as loudly as a chip. Now each role has one look:
 * a label over a value is the column header's quiet sentence case; a control
 * is sentence case at 0.75rem, the 1px border saying "press"; and a chip, a
 * status the eye should catch, keeps the small tracked caps alone. All three
 * are words, so all three set the ledger face: a control or a label inside a
 * money span would otherwise inherit the figures' monospace.
 */

/**
 * A form field's or a figure's label: a label over a value, so a column
 * header's type, in the ledger face even where it sits inside a money span.
 */
export const FIELD_LABEL = `${COLUMN_HEADER} font-ledger`;

/**
 * A small control inside a row or panel. Border and text colours per use;
 * touch-target sizing (`tap44`) too, since not every control sits in a row.
 */
export const CONTROL = "rounded-[2px] border px-1.5 py-0.5 font-ledger text-[0.75rem] leading-snug";

/** A status chip. Fill and text colour per use. */
export const CHIP =
  "whitespace-nowrap rounded-[2px] px-1.5 py-0.5 font-ledger text-[0.62rem] font-semibold uppercase tracking-[0.06em]";
