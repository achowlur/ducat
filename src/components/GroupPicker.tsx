"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { setTransactionGroup } from "../app/transactions/actions";
import { groupHref, MAX_GROUP_LABEL, normalizeGroupLabel } from "../lib/ui/groupFilter";

/**
 * ONE trip/project picker for the whole ledger, in the CategoryPicker mould:
 * the list of known labels crosses the wire once, the popover is rendered on
 * demand in a PORTAL (the table's overflow-x container clips both axes), and a
 * row carries at most one tiny element — a chip when tagged, NOTHING when not.
 * Untagged rows reach it through affordances that already exist (the merchant
 * actions menu, the transfer cell's own text), so a ledger of untagged rows
 * pays ~zero DOM for this feature.
 *
 * The four CategoryPicker bugs are not re-earned; each fix is replicated:
 * aria-disabled (never disabled) on triggers during the write, measured
 * viewport room with a maxHeight cap and an upward flip, mousemove (never
 * mouseenter) for hover-to-activate, and a keyboard start position that means
 * Enter-without-typing changes nothing.
 */

interface Target {
  transactionId: string;
  /** The row's current tag, so opening + Enter is a no-op. */
  groupLabel: string | null;
  /** What the header names — the merchant, or "this transaction". */
  rowLabel: string;
  anchor: HTMLElement;
}

interface GroupPickerContext {
  labels: string[];
  openPicker: (target: Target) => void;
  target: Target | null;
  pendingId: string | null;
}

const Ctx = createContext<GroupPickerContext | null>(null);

/**
 * Null-tolerant on purpose: CategoryButton renders its trip menu item only
 * when a provider is present, so the component stays usable in a tree that
 * has no trip support at all.
 */
export function useGroupPicker(): GroupPickerContext | null {
  return useContext(Ctx);
}

const POPOVER_WIDTH = 232;
const POPOVER_PREFERRED_HEIGHT = 280;
const POPOVER_MIN_HEIGHT = 160;
const VIEWPORT_GAP = 4;
const VIEWPORT_EDGE = 8;
const DESKTOP = "(min-width: 768px)";

interface Row {
  /** null clears the tag; otherwise the label this option assigns. */
  value: string | null;
  name: string;
  kind: "clear" | "label" | "create";
}

/**
 * Where the keyboard starts: the row's CURRENT label with no query (Enter
 * changes nothing — the native-select promise); with a query, the first
 * PREFIX match, falling back to the first row.
 */
function preferredIndex(rows: Row[], query: string, currentLabel: string | null): number {
  if (query !== "") {
    const prefix = rows.findIndex(
      (r) => r.kind === "label" && r.name.toLowerCase().startsWith(query),
    );
    return prefix === -1 ? 0 : prefix;
  }
  const current = rows.findIndex((r) => r.kind === "label" && r.value === currentLabel);
  return current === -1 ? 0 : current;
}

export function GroupPickerProvider({
  labels,
  children,
}: {
  labels: string[];
  children: React.ReactNode;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const openPicker = useCallback((next: Target) => setTarget(next), []);

  const close = useCallback(
    (restoreFocus: boolean) => {
      if (restoreFocus && target !== null) target.anchor.focus();
      setTarget(null);
    },
    [target],
  );

  const commit = useCallback(
    (label: string | null) => {
      if (target === null) return;
      const { transactionId, anchor } = target;
      setTarget(null);
      anchor.focus();
      setPendingId(transactionId);
      startTransition(async () => {
        try {
          await setTransactionGroup(transactionId, label);
        } finally {
          setPendingId(null);
        }
      });
    },
    [target],
  );

  const value = useMemo<GroupPickerContext>(
    () => ({ labels, openPicker, target, pendingId }),
    [labels, openPicker, target, pendingId],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {target !== null && (
        <Popover target={target} labels={labels} onPick={commit} onClose={close} />
      )}
    </Ctx.Provider>
  );
}

/** The list, mounted only while open — an idle page pays nothing for it. */
function Popover({
  target,
  labels,
  onPick,
  onClose,
}: {
  target: Target;
  labels: string[];
  onPick: (label: string | null) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);
  // Read once per opening: mounted by a click, unmounted on close, so a
  // resize between the two cannot happen.
  const [desktop] = useState(() => window.matchMedia(DESKTOP).matches);

  const q = query.trim().toLowerCase();
  const typed = normalizeGroupLabel(query);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    // Untagging is not a trip, so it sits above the list — and only exists
    // for a row that has something to clear.
    if (target.groupLabel !== null && (q === "" || "none untag".includes(q))) {
      out.push({ value: null, name: "— untag —", kind: "clear" });
    }
    for (const label of labels) {
      if (q === "" || label.toLowerCase().includes(q)) {
        out.push({ value: label, name: label, kind: "label" });
      }
    }
    // Free text becomes a NEW group, last so an existing label always outranks
    // it — unless the typed text IS an existing label, which must not fork a
    // near-duplicate.
    if (typed !== null && !labels.some((l) => l.toLowerCase() === typed.toLowerCase())) {
      out.push({ value: typed, name: `new trip: “${typed}”`, kind: "create" });
    }
    return out;
  }, [labels, q, typed, target.groupLabel]);

  const [active, setActive] = useState(() => preferredIndex(rows, q, target.groupLabel));
  // Re-aims as the query changes, but not on mount — that would undo the
  // "start on the current label" position.
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) {
      settled.current = true;
      return;
    }
    setActive(preferredIndex(rows, q, target.groupLabel));
  }, [rows, q, target.groupLabel]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Keep the active option visible. Rect deltas, not offsetTop — the rows and
  // the scrolling list need no shared offsetParent for this to hold.
  useLayoutEffect(() => {
    const node = activeRef.current;
    const list = listRef.current;
    if (node === null || list === null) return;
    const n = node.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    if (n.top < l.top) list.scrollTop -= l.top - n.top;
    else if (n.bottom > l.bottom) list.scrollTop += n.bottom - l.bottom;
  }, [active, query]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (rootRef.current?.contains(node) === true || target.anchor.contains(node)) return;
      onClose(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose, target.anchor]);

  // A fixed popover cannot follow the page: close on scroll/resize instead of
  // drifting from the row. The mobile sheet is viewport-pinned and needs
  // neither.
  useEffect(() => {
    if (!desktop) return;
    const dismiss = () => onClose(false);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [desktop, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose(true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[active] !== undefined) onPick(rows[active].value);
    } else if (e.key === "Tab") {
      // Not trapped: hand focus back and let the browser move on.
      onClose(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rows.length > 0) setActive((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length > 0) setActive((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, rows.length - 1));
    }
  };

  const listId = "group-picker-list";
  const optionId = (i: number) => `${listId}-${i}`;

  let position: React.CSSProperties;
  let shell: string;
  if (desktop) {
    const rect = target.anchor.getBoundingClientRect();
    const left = Math.min(
      Math.max(VIEWPORT_EDGE, rect.left),
      window.innerWidth - POPOVER_WIDTH - VIEWPORT_EDGE,
    );
    // Measure the room rather than assuming a height — the assumption is the
    // documented way off the bottom of the screen.
    const below = window.innerHeight - rect.bottom - VIEWPORT_GAP - VIEWPORT_EDGE;
    const above = rect.top - VIEWPORT_GAP - VIEWPORT_EDGE;
    const flip = below < POPOVER_PREFERRED_HEIGHT && above > below;
    const maxHeight = Math.max(POPOVER_MIN_HEIGHT, flip ? above : below);
    position = flip
      ? { left, bottom: window.innerHeight - rect.top + VIEWPORT_GAP, width: POPOVER_WIDTH, maxHeight }
      : { left, top: rect.bottom + VIEWPORT_GAP, width: POPOVER_WIDTH, maxHeight };
    shell = "rounded-[3px] border border-ink";
  } else {
    position = { left: 0, right: 0, bottom: 0, maxHeight: "78vh" };
    shell = "rounded-t-lg border-t border-ink";
  }

  return createPortal(
    <>
      {!desktop && (
        <div className="fixed inset-0 z-40 bg-black/30" onMouseDown={() => onClose(false)} aria-hidden="true" />
      )}
      <div
        ref={rootRef}
        style={position}
        className={`fixed z-50 flex flex-col overflow-hidden bg-paper shadow-md ${shell}`}
      >
        <div className="flex flex-col gap-1 border-b border-rule px-2 py-1.5">
          <span className="truncate font-money text-[0.6rem] uppercase tracking-[0.08em] text-faint">
            trip for <span className="text-acc">{target.rowLabel}</span>
          </span>
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label="Trip or project name"
            aria-activedescendant={rows[active] === undefined ? undefined : optionId(active)}
            value={query}
            maxLength={MAX_GROUP_LABEL}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find or name a trip"
            className="w-full rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.85rem] text-ink outline-none focus:border-acc md:text-[0.8rem]"
          />
        </div>

        <ul ref={listRef} id={listId} role="listbox" aria-label="Trip" className="flex-1 overflow-y-auto py-1">
          {rows.length === 0 && (
            <li role="presentation" className="px-2 py-2 text-[0.78rem] text-faint">
              Type a name to start a trip.
            </li>
          )}
          {rows.map((row, i) => {
            const selected = row.kind === "label" && row.value === target.groupLabel;
            const hit = row.kind !== "label" || q === "" ? -1 : row.name.toLowerCase().indexOf(q);
            return (
              <li
                key={`${row.kind}:${row.value ?? ""}`}
                id={optionId(i)}
                ref={i === active ? activeRef : undefined}
                role="option"
                aria-selected={selected}
                // Keeps focus (and type-ahead) in the search field.
                onMouseDown={(e) => e.preventDefault()}
                // mousemove, not mouseenter: the popover opens under a
                // stationary cursor, and mouseenter fires on appearance.
                onMouseMove={() => setActive(i)}
                onClick={() => onPick(row.value)}
                className={`flex cursor-pointer items-center justify-between gap-2 px-2 py-3 text-[0.9rem] md:py-1 md:text-[0.82rem] ${
                  i === active ? "bg-chip shadow-[inset_2px_0_0_var(--acc)]" : ""
                } ${row.kind === "create" ? "text-acc" : ""}`}
              >
                <span className="truncate">
                  {hit === -1 ? (
                    row.name
                  ) : (
                    <>
                      {row.name.slice(0, hit)}
                      <span className="font-semibold text-acc">{row.name.slice(hit, hit + q.length)}</span>
                      {row.name.slice(hit + q.length)}
                    </>
                  )}
                </span>
                {selected && <span className="text-[0.72rem] text-acc">✓</span>}
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap items-baseline gap-2 border-t border-rule px-2 py-1 font-money text-[0.58rem] text-faint">
          <span>↑↓ move</span>
          <span>enter set</span>
          <span>esc cancel</span>
          {target.groupLabel !== null && (
            <Link href={groupHref(target.groupLabel)} className="ml-auto text-acc hover:underline">
              all “{target.groupLabel}” rows →
            </Link>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * The chip a TAGGED row carries — its label, opening the picker to change or
 * untag. One element; untagged rows render nothing at all.
 */
export function GroupChip({
  transactionId,
  groupLabel,
  rowLabel,
}: {
  transactionId: string;
  groupLabel: string;
  rowLabel: string;
}) {
  const ctx = useGroupPicker();
  const ref = useRef<HTMLButtonElement>(null);
  if (ctx === null) return null;
  const pending = ctx.pendingId === transactionId;
  return (
    <button
      ref={ref}
      type="button"
      // aria-disabled, never disabled: a disabled element cannot hold focus,
      // and blurring to <body> mid-write loses the reader's place.
      aria-disabled={pending}
      aria-haspopup="listbox"
      onClick={() => {
        if (pending || ref.current === null) return;
        ctx.openPicker({ transactionId, groupLabel, rowLabel, anchor: ref.current });
      }}
      className={`max-w-[120px] truncate rounded-[2px] bg-chip px-1 py-0.5 text-[0.62rem] font-semibold text-acc ${pending ? "opacity-50" : ""}`}
      title={`Part of “${groupLabel}” — change or untag`}
    >
      {groupLabel}
    </button>
  );
}

/**
 * A trip trigger for rows that have no merchant actions menu (the transfer
 * cell's own text, the linked-reimbursement “+”). Renders whatever children
 * it is given, so wrapping existing text costs zero extra elements.
 */
export function GroupTrigger({
  transactionId,
  groupLabel,
  rowLabel,
  className,
  title,
  children,
}: {
  transactionId: string;
  groupLabel: string | null;
  rowLabel: string;
  className: string;
  title: string;
  children: React.ReactNode;
}) {
  const ctx = useGroupPicker();
  const ref = useRef<HTMLButtonElement>(null);
  if (ctx === null) return <span className={className}>{children}</span>;
  const pending = ctx.pendingId === transactionId;
  return (
    <button
      ref={ref}
      type="button"
      aria-disabled={pending}
      aria-haspopup="listbox"
      onClick={() => {
        if (pending || ref.current === null) return;
        ctx.openPicker({ transactionId, groupLabel, rowLabel, anchor: ref.current });
      }}
      className={`${className} ${pending ? "opacity-50" : ""}`}
      title={title}
    >
      {children}
    </button>
  );
}
