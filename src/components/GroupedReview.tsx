"use client";

import { useState, useTransition } from "react";
import { categorizeGroup, undoCategorizeGroup } from "../app/transactions/actions";
import type { GroupUndo } from "../lib/sync/rulePack";
import { TRANSFER_TARGET } from "../lib/sync/grouping";
import type { CategoryOption } from "./CategoryPicker";

export interface PayeeGroupView {
  key: string;
  label: string;
  matchField: "MERCHANT" | "DESCRIPTION";
  isP2P: boolean;
  count: number;
  total: string;
  samples: string[];
  flow: string;
}

interface Applied {
  undo: GroupUndo;
  payee: string;
  category: string;
  recategorized: number;
}

const FLOW_CLASS: Record<string, string> = {
  INFLOW: "text-pos",
  OUTFLOW: "text-faint",
  TRANSFER: "text-acc",
  MIXED: "text-acc",
};

function GroupRow({
  group,
  categories,
  onApplied,
  onSkip,
}: {
  group: PayeeGroupView;
  categories: CategoryOption[];
  onApplied: (applied: Applied) => void;
  onSkip: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The choice is STAGED, not committed. A select fires `change` for every
  // option an arrow key passes over, so committing here meant one keystroke
  // on a focused select rewrote up to 93 transactions and wrote a permanent
  // priority-50 rule, with no statement beforehand of how many rows it hits.
  const [staged, setStaged] = useState("");

  const labelFor = (id: string) =>
    id === TRANSFER_TARGET ? "Transfer" : (categories.find((c) => c.id === id)?.name ?? id);

  function apply() {
    if (staged === "") return;
    setError(null);
    const chosen = staged;
    startTransition(async () => {
      try {
        const result = await categorizeGroup(group.key, group.matchField, chosen);
        setStaged("");
        onApplied({
          undo: result.undo,
          payee: group.label,
          category: labelFor(chosen),
          recategorized: result.recategorized,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to apply.");
      }
    });
  }

  return (
    <tr className={`border-b border-rule align-top ${pending ? "opacity-50" : ""}`}>
      <td className="py-2 pr-3 text-right font-money text-[0.85rem] tabular font-semibold">{group.count}×</td>
      <td className="max-w-[380px] py-2 pr-3">
        <div className="text-[0.85rem]">
          {group.label}
          {group.isP2P && (
            <span
              className="ml-2 rounded-[2px] border border-neg px-1 py-0.5 text-[0.6rem] font-semibold uppercase tracking-[0.05em] text-neg"
              title="Peer-to-peer payment. The rule will match this specific counterparty in the description, not the payment rail — other Zelle/Venmo payees stay untouched."
            >
              p2p
            </span>
          )}
        </div>
        {/* The evidence for the decision, in the open. It used to be one
            truncated sample with the rest behind title=, which does not exist
            on touch at all — the deciding information was invisible on the
            device the queue is most likely to be worked through on. */}
        <div className="grid gap-0.5 pt-0.5 text-[0.7rem] break-words text-faint">
          {group.samples.slice(0, 3).map((s, i) => (
            <div key={`${s}-${i}`}>{s}</div>
          ))}
          {group.count > 3 && group.samples.length >= 3 && (
            <div className="opacity-70">+{group.count - Math.min(3, group.samples.length)} more</div>
          )}
        </div>
        {error !== null && <div className="text-[0.7rem] text-neg">{error}</div>}
      </td>
      <td className={`py-2 pr-3 text-[0.68rem] uppercase tracking-[0.06em] ${FLOW_CLASS[group.flow] ?? "text-faint"}`}>
        {group.flow.toLowerCase()}
      </td>
      <td className="py-2 pr-3 text-right font-money text-[0.85rem] tabular">{group.total}</td>
      <td className="py-2">
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <select
            value={staged}
            disabled={pending}
            onChange={(e) => setStaged(e.target.value)}
            className="max-w-[150px] rounded-[2px] border border-rule bg-paper py-0.5 pl-1 pr-4 text-[0.78rem] text-ink"
            title={`Pick a category for all ${group.count}, then confirm`}
          >
            <option value="">{pending ? "applying…" : "categorize all…"}</option>
            <optgroup label="Spending">
              {categories.filter((c) => !c.isIncome).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Income">
              {categories.filter((c) => c.isIncome).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Not spending">
              <option value={TRANSFER_TARGET}>Transfer — exclude</option>
            </optgroup>
          </select>
          {staged === "" && !pending && (
            // Without a defer, a payee you cannot resolve sits at the top of
            // the queue forever and the queue stops feeling finishable.
            <button
              onClick={onSkip}
              className="rounded-[2px] border border-rule px-1.5 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc"
              title="Not now — hide this payee for the rest of this session. Nothing is written."
            >
              skip
            </button>
          )}
          {staged !== "" && !pending && (
            // The count is the scope preview: this is the only place the size
            // of the write is stated before it happens.
            <button
              onClick={apply}
              className="rounded-[2px] border border-acc bg-acc px-1.5 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-paper"
              title={`Write a rule for "${group.key}" and categorize all ${group.count} as ${labelFor(staged)}`}
            >
              apply to {group.count} →
            </button>
          )}
        </span>
      </td>
    </tr>
  );
}

/**
 * Bulk review: one decision per payee instead of per transaction. Each choice
 * writes a user rule, so it also categorizes future transactions from that
 * payee automatically — which is exactly why it is confirmed before it runs
 * and reversible after.
 */
export function GroupedReview({
  groups,
  categories,
}: {
  groups: PayeeGroupView[];
  categories: CategoryOption[];
}) {
  // Lives on the parent because the row that was just resolved disappears
  // from `groups` on the next render — an undo control on the row would
  // vanish with it.
  const [last, setLast] = useState<Applied | null>(null);
  const [undoing, startUndo] = useTransition();
  // Session-scoped on purpose: a skip is "not now", not a decision, so it
  // must not outlive the sitting or quietly shrink the backlog for good.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [showSkipped, setShowSkipped] = useState(false);
  const visible = showSkipped ? groups : groups.filter((g) => !skipped.includes(g.key));

  if (groups.length === 0 && last === null) {
    return (
      <p className="py-6 text-center text-[0.85rem] text-faint">
        Nothing left to review — every transaction has a category.
      </p>
    );
  }

  return (
    <>
      {last !== null && (
        <div className="flex flex-wrap items-center gap-3 border-b border-rule py-2 text-[0.78rem]">
          <span className="text-faint">
            {last.payee} → <span className="text-ink">{last.category}</span>, {last.recategorized}{" "}
            transaction{last.recategorized === 1 ? "" : "s"} recategorized and a rule written for future ones.
          </span>
          <button
            disabled={undoing}
            onClick={() =>
              startUndo(async () => {
                await undoCategorizeGroup(last.undo);
                setLast(null);
              })
            }
            className="rounded-[2px] border border-rule px-1.5 py-0.5 text-[0.62rem] uppercase tracking-[0.05em] text-faint hover:border-acc hover:text-acc"
            title="Restore every one of those transactions and remove the rule this created"
          >
            {undoing ? "undoing…" : "undo"}
          </button>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="flex items-center gap-3 py-2 text-[0.78rem] text-faint">
          <span>
            {skipped.length} payee{skipped.length === 1 ? "" : "s"} skipped this session
          </span>
          <button
            onClick={() => setShowSkipped(!showSkipped)}
            className="font-semibold text-acc hover:underline"
          >
            {showSkipped ? "hide them" : "show them"}
          </button>
        </div>
      )}
      {groups.length === 0 ? (
        <p className="py-6 text-center text-[0.85rem] text-faint">
          Nothing left to review — every transaction has a category.
        </p>
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-[0.85rem] text-faint">
          Everything left is skipped for this session.
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-ink">
              {["Count", "Payee", "Flow", "Total", "Categorize all"].map((h, i) => (
                <th
                  key={h}
                  className={`py-1 text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-faint ${
                    i === 0 || i === 3 ? "text-right" : "text-left"
                  }`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((g) => (
              <GroupRow
                key={g.key}
                group={g}
                categories={categories}
                onApplied={setLast}
                onSkip={() => setSkipped((s) => (s.includes(g.key) ? s : [...s, g.key]))}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
