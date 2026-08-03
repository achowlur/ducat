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
import {
  createRuleFromMerchant,
  registerSubscription,
  setTransactionCategory,
  unregisterSubscription,
} from "../app/transactions/actions";
import { useGroupPicker } from "./GroupPicker";
import type { RecurringCadence } from "../types/contracts";

export interface CategoryOption {
  id: string;
  name: string;
  isIncome: boolean;
}

/**
 * One category picker for the whole ledger, instead of one <select> per row.
 *
 * Every row used to carry the entire category list: 19 elements each (select +
 * 2 optgroups + 16 options), which on a 100-row page measured 1672 elements —
 * 53.4% of the document — against 3132 in total. That is not a transfer cost
 * (Vercel serves brotli, and 88 identical selects compress to nothing); it is
 * parse, DOM construction and hydration on the client's CPU, which is what made
 * the page feel busy for a second after it appeared.
 *
 * So the list is rendered ONCE, on demand, and a row carries a button. What a
 * native <select> gave away free has to be rebuilt deliberately — Escape,
 * arrows, Home/End, type-ahead, focus restore, click-outside, listbox roles —
 * because correcting four rows in a month is the actual job, and a picker that
 * is fast but loses type-to-select is a downgrade. Each of those is implemented
 * below and none of them is optional.
 */

interface Target {
  transactionId: string;
  merchant: string;
  /** What a rule from this row matches on — see `merchantLabel`. */
  ruleValue: string;
  ruleField: "MERCHANT" | "DESCRIPTION";
  categoryId: string | null;
  /** Rule mode: the pick writes `merchant contains "X"` instead of one row. */
  ruleMode: boolean;
  /** Type-ahead: the keystroke that opened the picker, pre-filling the search. */
  seed: string;
  anchor: HTMLElement;
}

interface PickerContext {
  categories: CategoryOption[];
  nameOf: (id: string | null) => string | null;
  openPicker: (target: Target) => void;
  target: Target | null;
  pendingId: string | null;
}

const Ctx = createContext<PickerContext | null>(null);

function usePicker(): PickerContext {
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error("CategoryButton must be rendered inside a CategoryPickerProvider.");
  return ctx;
}

const POPOVER_WIDTH = 232;
/** Room we'd LIKE below the trigger before considering a flip upwards. */
const POPOVER_PREFERRED_HEIGHT = 320;
/** Below this the popover is useless, so it scrolls rather than shrinking further. */
const POPOVER_MIN_HEIGHT = 180;
const VIEWPORT_GAP = 4;
const VIEWPORT_EDGE = 8;
const DESKTOP = "(min-width: 768px)";

/**
 * Which option the keyboard starts on.
 *
 * With no query that is the row's CURRENT category, so opening and pressing
 * Enter changes nothing — the same promise a native select makes. With a query
 * it is the first PREFIX match, falling back to the first substring match:
 * searching is more useful than native type-ahead ("housing" finds
 * "Rent & Housing"), but typing "g" still has to land on Gas rather than on
 * Dining, which merely contains a g.
 */
function preferredIndex(
  rows: { id: string | null; name: string }[],
  query: string,
  currentId: string | null,
): number {
  if (query !== "") {
    const prefix = rows.findIndex((r) => r.name.toLowerCase().startsWith(query));
    return prefix === -1 ? 0 : prefix;
  }
  const current = rows.findIndex((r) => r.id === currentId);
  return current === -1 ? 0 : current;
}

export function CategoryPickerProvider({
  categories,
  children,
}: {
  categories: CategoryOption[];
  children: React.ReactNode;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const nameOf = useCallback(
    (id: string | null) => (id === null ? null : (byId.get(id) ?? null)),
    [byId],
  );

  const openPicker = useCallback((next: Target) => setTarget(next), []);

  // Clicking away should leave focus where it was clicked; dismissing with the
  // keyboard has to put it back on the row, or Escape strands you at the top of
  // the document. Focus moves here rather than inside the state updater, which
  // has to stay pure.
  const close = useCallback(
    (restoreFocus: boolean) => {
      if (restoreFocus && target !== null) target.anchor.focus();
      setTarget(null);
    },
    [target],
  );

  const commit = useCallback(
    (categoryId: string | null) => {
      if (target === null) return;
      const { transactionId, ruleValue, ruleField, ruleMode, anchor } = target;
      setTarget(null);
      anchor.focus();
      setPendingId(transactionId);
      startTransition(async () => {
        try {
          // Rule mode never offers "none" — a rule has to assign something —
          // so this branch cannot be reached with a null category.
          if (ruleMode && categoryId !== null)
            await createRuleFromMerchant(ruleValue, categoryId, ruleField);
          else await setTransactionCategory(transactionId, categoryId);
        } finally {
          setPendingId(null);
        }
      });
    },
    [target],
  );

  const value = useMemo<PickerContext>(
    () => ({ categories, nameOf, openPicker, target, pendingId }),
    [categories, nameOf, openPicker, target, pendingId],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {target !== null && <Picker target={target} categories={categories} onPick={commit} onClose={close} />}
    </Ctx.Provider>
  );
}

/** The list, rendered once. Mounted only while open, so it never costs an idle page anything. */
function Picker({
  target,
  categories,
  onPick,
  onClose,
}: {
  target: Target;
  categories: CategoryOption[];
  onPick: (categoryId: string | null) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const [query, setQuery] = useState(target.seed);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);
  // Read once per opening rather than subscribed: the picker is mounted by a
  // click and unmounted on close, so a resize between the two cannot happen.
  const [desktop] = useState(() => window.matchMedia(DESKTOP).matches);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const hit = (c: CategoryOption) => q === "" || c.name.toLowerCase().includes(q);
    const out: { label: string | null; rows: { id: string | null; name: string }[] }[] = [];
    // Clearing a category is not a category, so it sits above the groups —
    // and rule mode omits it entirely.
    if (!target.ruleMode && (q === "" || "none".includes(q))) {
      out.push({ label: null, rows: [{ id: null, name: "— none —" }] });
    }
    const spending = categories.filter((c) => !c.isIncome && hit(c));
    const income = categories.filter((c) => c.isIncome && hit(c));
    if (spending.length > 0) out.push({ label: "Spending", rows: spending });
    if (income.length > 0) out.push({ label: "Income", rows: income });
    return out;
  }, [categories, q, target.ruleMode]);

  // Flattened in display order — what the arrow keys actually walk.
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  const [active, setActive] = useState(() => preferredIndex(flat, q, target.categoryId));
  // Re-aims at the best match as the query changes, but must not fire on mount
  // and undo the initial "start on the current category".
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) {
      settled.current = true;
      return;
    }
    setActive(preferredIndex(flat, q, target.categoryId));
  }, [flat, q, target.categoryId]);

  useEffect(() => {
    searchRef.current?.focus();
    searchRef.current?.setSelectionRange(query.length, query.length);
    // Focusing on open only; `query` changes as the user types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the active option visible. Rect deltas rather than offsetTop, because
  // options are nested inside their group's <ul> and so do not share an
  // offsetParent with the scrolling list.
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

  // A fixed popover cannot follow the page, so it closes instead of drifting
  // away from the row it belongs to — which is what a native select does too.
  // The sheet is pinned to the bottom of the viewport and needs none of this.
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
      if (flat[active] !== undefined) onPick(flat[active].id);
    } else if (e.key === "Tab") {
      // Not trapped: close, hand focus back to the trigger, and let the browser
      // move on from there exactly as it would have from the select.
      onClose(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length > 0) setActive((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length > 0) setActive((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, flat.length - 1));
    }
  };

  const listId = "category-picker-list";
  const optionId = (i: number) => `${listId}-${i}`;

  let position: React.CSSProperties;
  let shell: string;
  if (desktop) {
    const rect = target.anchor.getBoundingClientRect();
    const left = Math.min(Math.max(VIEWPORT_EDGE, rect.left), window.innerWidth - POPOVER_WIDTH - VIEWPORT_EDGE);
    // Measure the room rather than assuming a height. Guessing one put a 579px
    // popover under a row 275px down an 800px viewport and ran it 58px off the
    // bottom of the screen, because the list grows with the category count and
    // nothing capped it.
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

  let index = -1;

  return createPortal(
    <>
      {/* The sheet's scrim is also its dismissal target, so it is a real
          element on mobile and absent on desktop, where click-outside covers it. */}
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
            {/* States the rule it will actually write, field and all: for a
                P2P row that is the DESCRIPTION and the counterparty, not the
                merchant and the rail. */}
            {target.ruleMode ? `rule: ${target.ruleField.toLowerCase()} contains ` : "categorize "}
            <span className="text-acc">
              {target.ruleMode
                ? target.ruleValue
                : target.merchant === ""
                  ? "this transaction"
                  : target.merchant}
            </span>
          </span>
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label="Search categories"
            aria-activedescendant={flat[active] === undefined ? undefined : optionId(active)}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search categories"
            className="w-full rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.85rem] text-ink outline-none focus:border-acc md:text-[0.8rem]"
          />
        </div>

        <ul ref={listRef} id={listId} role="listbox" aria-label="Category" className="flex-1 overflow-y-auto py-1">
          {flat.length === 0 && (
            <li role="presentation" className="px-2 py-2 text-[0.78rem] text-faint">
              No category matches “{query.trim()}”.
            </li>
          )}
          {groups.map((group) => {
            const rows = group.rows.map((row) => {
              index += 1;
              const i = index;
              const selected = row.id === target.categoryId;
              const hit = q === "" ? -1 : row.name.toLowerCase().indexOf(q);
              return (
                <li
                  key={row.id ?? "none"}
                  id={optionId(i)}
                  ref={i === active ? activeRef : undefined}
                  role="option"
                  aria-selected={selected}
                  // Keeps focus (and therefore type-ahead) in the search field.
                  onMouseDown={(e) => e.preventDefault()}
                  // mousemove, not mouseenter: the popover opens under a
                  // stationary cursor, and mouseenter fires on appearance —
                  // which silently handed the keyboard whichever option
                  // happened to be under the mouse.
                  onMouseMove={() => setActive(i)}
                  onClick={() => onPick(row.id)}
                  // py-3 on the sheet clears the 44px thumb target; the desktop
                  // popover is a mouse target and stays dense.
                  className={`flex cursor-pointer items-center justify-between gap-2 px-2 py-3 text-[0.9rem] md:py-1 md:text-[0.82rem] ${
                    i === active ? "bg-chip shadow-[inset_2px_0_0_var(--acc)]" : ""
                  }`}
                >
                  <span>
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
            });
            if (group.label === null) return rows;
            return (
              <li key={group.label} role="presentation">
                <ul role="group" aria-label={group.label}>
                  <li
                    role="presentation"
                    className="px-2 pb-0.5 pt-1.5 font-money text-[0.58rem] uppercase tracking-[0.1em] text-faint"
                  >
                    {group.label}
                  </li>
                  {rows}
                </ul>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap gap-2 border-t border-rule px-2 py-1 font-money text-[0.58rem] text-faint">
          <span>↑↓ move</span>
          <span>enter set</span>
          <span>esc cancel</span>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** Cadences a subscription can be declared at; the one thing a single charge can't tell you. */
const CADENCES: { value: RecurringCadence; label: string }[] = [
  { value: "WEEKLY", label: "wk" },
  { value: "MONTHLY", label: "mo" },
  { value: "QUARTERLY", label: "qtr" },
  { value: "YEARLY", label: "yr" },
];

/**
 * The per-row control: a button, the ✎ that marks a manual assignment, and the
 * `rule` toggle. Three or four elements, against the 19 the select cost.
 *
 * `rule` opens a two-item menu rather than going straight to the picker,
 * because both things you can say about a MERCHANT — categorize all of them,
 * or track it as a subscription — belong behind one affordance. Subscription
 * tracking had its own permanent button for a while and that was the wrong
 * economics: a control on all ~228 rows for something used a handful of times a
 * year. Nothing renders until the menu is opened, so a row nobody is editing
 * pays for none of it.
 */
export function CategoryButton({
  transactionId,
  merchant,
  ruleValue,
  ruleField,
  categoryId,
  categorySource,
  subscriptionPattern,
  subscriptionTracked,
  groupLabel = null,
}: {
  transactionId: string;
  /** Display name — the payee for a P2P row, not the rail. */
  merchant: string;
  /** What a rule from this row matches on, and where. */
  ruleValue: string;
  ruleField: "MERCHANT" | "DESCRIPTION";
  categoryId: string | null;
  categorySource: string;
  /** Null when this row can't be tracked — no merchant, or too short to match safely. */
  subscriptionPattern: string | null;
  subscriptionTracked: boolean;
  /** The row's trip/project tag, for the trip menu item's picker. */
  groupLabel?: string | null;
}) {
  const { nameOf, openPicker, target, pendingId } = usePicker();
  // Null-tolerant: the trip item renders only inside a GroupPickerProvider.
  const groupCtx = useGroupPicker();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ruleRef = useRef<HTMLButtonElement>(null);
  const tripRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<"closed" | "actions" | "cadence">("closed");
  const [subPending, startSub] = useTransition();
  const [subError, setSubError] = useState<string | null>(null);

  const open = target !== null && target.transactionId === transactionId;
  const pending = pendingId === transactionId;
  const name = nameOf(categoryId);

  const show = (ruleMode: boolean, seed: string) => {
    const anchor = (ruleMode ? ruleRef.current : triggerRef.current) ?? triggerRef.current;
    if (anchor === null) return;
    openPicker({ transactionId, merchant, ruleValue, ruleField, categoryId, ruleMode, seed, anchor });
  };

  return (
    // Wraps below md so the trigger and the `rule` menu opener can stack
    // instead of forcing a 168px column. That column plus date and merchant
    // needed 366px in a 327px scroller, which is what kept the amount off
    // screen. Hiding `rule` on a phone would have been cheaper and wrong — it
    // is the only route to trip tagging and to categorizing a merchant in
    // bulk, and bulk review on a phone is exactly when those are wanted.
    <span className="inline-flex items-center gap-1.5">
      <button
        ref={triggerRef}
        type="button"
        // aria-disabled, NOT disabled: a disabled element cannot hold focus, so
        // the browser blurred the trigger to <body> the instant a write started
        // — losing your place in the ledger after every single categorization.
        aria-disabled={pending}
        aria-haspopup="listbox"
        aria-expanded={open && !target.ruleMode}
        onClick={() => {
          if (pending || open) return;
          show(false, "");
        }}
        onKeyDown={(e) => {
          if (pending) return;
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            show(false, "");
          } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // Type-ahead, as the select had it: a letter opens the list already
            // filtered rather than doing nothing.
            e.preventDefault();
            show(false, e.key);
          }
        }}
        className={`inline-flex max-w-[148px] items-center gap-1 rounded-[2px] border bg-paper py-0.5 pl-1 pr-1.5 text-[0.78rem] max-md:min-h-[44px] max-md:max-w-[100px] ${
          name === null ? "border-rule text-faint" : "border-transparent text-ink hover:border-rule"
        } ${pending ? "opacity-50" : ""}`}
        title={
          categorySource === "MANUAL" && categoryId !== null
            ? "Set manually"
            : categorySource === "RULE"
              ? "Set by rule"
              : "Uncategorized"
        }
      >
        <span className="truncate">{name ?? "—"}</span>
        <span aria-hidden="true" className="text-[0.55rem] text-faint">
          ▾
        </span>
      </button>
      {categorySource === "MANUAL" && categoryId !== null && (
        <span className="text-[0.62rem] text-faint" title="Set manually — rules never override this">
          ✎
        </span>
      )}
      {subscriptionTracked && (
        <span
          className="text-[0.62rem] text-acc"
          title="Tracked as a subscription — its renewal date and price changes are on Overview"
        >
          ↻
        </span>
      )}
      {menu === "actions" && (
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setMenu("closed");
              show(true, "");
            }}
            className="rounded-[2px] border border-rule px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc"
            title={`Categorize every "${merchant}" transaction, past and future`}
          >
            category
          </button>
          {subscriptionPattern !== null &&
            (subscriptionTracked ? (
              <button
                type="button"
                aria-disabled={subPending}
                onClick={() => {
                  if (subPending) return;
                  startSub(async () => {
                    await unregisterSubscription(subscriptionPattern);
                    setMenu("closed");
                  });
                }}
                className="rounded-[2px] border border-rule px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-neg hover:text-neg"
                title={`Stop tracking "${subscriptionPattern}" as a subscription`}
              >
                untrack
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setMenu("cadence")}
                className="rounded-[2px] border border-rule px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc"
                title="Track this merchant as a subscription — its renewal date and price changes, without waiting for the detector's three charges"
              >
                subscription
              </button>
            ))}
          {groupCtx !== null && (
            <button
              ref={tripRef}
              type="button"
              onClick={() => {
                // The menu stays open: this button is the picker's anchor, and
                // an unmounted anchor measures a zero rect and takes no focus.
                if (tripRef.current === null || groupCtx.pendingId === transactionId) return;
                groupCtx.openPicker({
                  transactionId,
                  groupLabel,
                  rowLabel: merchant === "" ? "this transaction" : merchant,
                  anchor: tripRef.current,
                });
              }}
              className="tap44 rounded-[2px] border border-rule px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc"
              title="Tag THIS transaction into a trip or project — a view across months, never a category"
            >
              trip
            </button>
          )}
          <button
            type="button"
            onClick={() => setMenu("closed")}
            className="text-[0.62rem] text-faint hover:text-ink"
            aria-label="Close merchant actions"
          >
            ×
          </button>
        </span>
      )}
      {menu === "cadence" && (
        <span className="inline-flex items-center gap-1">
          <span className="font-money text-[0.58rem] uppercase tracking-[0.05em] text-faint">billed every</span>
          {CADENCES.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-disabled={subPending}
              onClick={() => {
                if (subPending || subscriptionPattern === null) return;
                setSubError(null);
                startSub(async () => {
                  try {
                    await registerSubscription(transactionId, c.value);
                    setMenu("closed");
                  } catch (e) {
                    setSubError(e instanceof Error ? e.message : "Could not track this one.");
                  }
                });
              }}
              className="rounded-[2px] border border-rule px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc"
            >
              {c.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setMenu("closed");
              setSubError(null);
            }}
            className="text-[0.62rem] text-faint hover:text-ink"
            aria-label="Cancel"
          >
            ×
          </button>
          {subError !== null && <span className="text-[0.62rem] text-neg">{subError}</span>}
        </span>
      )}
      {merchant !== "" && menu === "closed" && (
        <button
          ref={ruleRef}
          type="button"
          aria-disabled={pending}
          aria-haspopup="menu"
          aria-expanded={false}
          onClick={() => {
            if (pending) return;
            setMenu("actions");
          }}
          className={`tap44 rounded-[2px] border px-1 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] ${
            open && target.ruleMode
              ? "border-acc bg-acc text-paper"
              : "border-rule text-faint hover:border-acc hover:text-acc"
          }`}
          title={`What should happen for every "${merchant}" transaction`}
        >
          rule
        </button>
      )}
    </span>
  );
}
