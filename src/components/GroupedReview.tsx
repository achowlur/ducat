"use client";

import { useState, useTransition } from "react";
import { categorizeGroup, categorizeGroups, undoCategorizeGroup } from "../app/transactions/actions";
import type { GroupUndo } from "../lib/sync/rulePack";
import { TRANSFER_TARGET } from "../lib/sync/grouping";
import { ACTION_DID_NOT_COMPLETE } from "../lib/ui/boundaryCopy";
import type { CategoryOption } from "./CategoryPicker";
import { CHIP, COLUMN_HEADER, CONTROL } from "./ui/headings";

export interface PayeeGroupView {
  key: string;
  label: string;
  matchField: "MERCHANT" | "DESCRIPTION";
  isP2P: boolean;
  count: number;
  total: string;
  samples: string[];
  flow: string;
  /**
   * A suggested category (lib/sync/groupSuggest.ts). STRONG pre-fills the
   * choice; a GUESS is offered beside it and never pre-filled, so "apply all"
   * never applies a guess nobody looked at.
   */
  suggestion: { categoryId: string; categoryName: string; reason: string; strength: "strong" | "guess" } | null;
}

interface Applied {
  undo: GroupUndo;
  /** What was done, in a sentence, for the undo banner. */
  summary: string;
}

const FLOW_CLASS: Record<string, string> = {
  INFLOW: "text-pos",
  OUTFLOW: "text-faint",
  TRANSFER: "text-acc",
  MIXED: "text-acc",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function GroupRow({
  group,
  categories,
  choice,
  onChoose,
  busy,
  onApplied,
  onSkip,
}: {
  group: PayeeGroupView;
  categories: CategoryOption[];
  /** The staged category: the operator's pick, or a strong suggestion until they change it. */
  choice: string;
  onChoose: (value: string) => void;
  /** Another write (apply all, undo) is in flight: hold this row's controls. */
  busy: boolean;
  onApplied: (applied: Applied) => void;
  onSkip: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const locked = pending || busy;

  const labelFor = (id: string) =>
    id === TRANSFER_TARGET ? "Transfer" : (categories.find((c) => c.id === id)?.name ?? id);

  // The choice is STAGED, not committed. A select fires `change` for every
  // option an arrow key passes over, so committing there meant one keystroke
  // on a focused select rewrote up to 93 transactions and wrote a permanent
  // priority-50 rule, with no statement beforehand of how many rows it hits.
  function apply() {
    if (choice === "") return;
    setError(null);
    const chosen = choice;
    startTransition(async () => {
      try {
        const result = await categorizeGroup(group.key, group.matchField, chosen);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        onApplied({
          undo: result.undo,
          summary: `${group.label} → ${labelFor(chosen)}, ${plural(result.recategorized, "transaction")} recategorized and a rule written for future ones.`,
        });
      } catch {
        // Never e.message: production replaces it with a placeholder. And
        // nothing about what was written, which this cannot know.
        setError(ACTION_DID_NOT_COMPLETE);
      }
    });
  }

  const s = group.suggestion;
  return (
    <tr className={`border-b border-rule align-top ${locked ? "opacity-50" : ""}`}>
      <td className="py-2 pr-3 text-right font-money text-[0.85rem] tabular font-semibold">{group.count}×</td>
      <td className="max-w-[380px] py-2 pr-3">
        <div className="text-[0.85rem]">
          {group.label}
          {group.isP2P && (
            <span
              className={`${CHIP} ml-2 border border-neg text-neg`}
              title="Peer-to-peer payment. The rule will match this specific counterparty in the description, not the payment rail; other Zelle/Venmo payees stay untouched."
            >
              p2p
            </span>
          )}
        </div>
        {/* Below md the flow and total ride under the name: five columns
            measured 454px at 375, so the queue opened zoomed out on a phone. */}
        <div className="text-[0.72rem] md:hidden">
          <span className={FLOW_CLASS[group.flow] ?? "text-faint"}>
            {group.flow.charAt(0) + group.flow.slice(1).toLowerCase()}
          </span>
          <span className="font-money tabular text-faint"> · {group.total}</span>
        </div>
        {/* The evidence for the decision, in the open. It used to be one
            truncated sample with the rest behind title=, which does not exist
            on touch at all — the deciding information was invisible on the
            device the queue is most likely to be worked through on. */}
        <div className="grid gap-0.5 pt-0.5 text-[0.7rem] break-words text-faint">
          {group.samples.slice(0, 3).map((sample, i) => (
            <div key={`${sample}-${i}`}>{sample}</div>
          ))}
          {group.count > 3 && group.samples.length >= 3 && (
            <div className="opacity-70">+{group.count - Math.min(3, group.samples.length)} more</div>
          )}
        </div>
        {/* Why the suggestion, in words, so a wrong one is caught by reading
            it rather than by applying it. A guess is a button: it fills the
            choice only when tapped. */}
        {s !== null && s.strength === "strong" && (
          <div className="pt-1 text-[0.72rem] text-faint">
            Suggested <span className="text-ink">{s.categoryName}</span>: {s.reason}
          </div>
        )}
        {s !== null && s.strength === "guess" && (
          <div className="flex flex-wrap items-center gap-x-2 pt-1 text-[0.72rem] text-faint">
            <button
              type="button"
              disabled={locked || choice === s.categoryId}
              onClick={() => onChoose(s.categoryId)}
              className={`${CONTROL} tap44 border-rule text-faint hover:border-acc hover:text-acc disabled:opacity-60`}
            >
              {choice === s.categoryId ? `Chose ${s.categoryName}` : `Guess: ${s.categoryName}`}
            </button>
            <span>{s.reason}</span>
          </div>
        )}
        {error !== null && <div className="text-[0.7rem] text-neg">{error}</div>}
      </td>
      <td className={`hidden py-2 pr-3 text-[0.75rem] md:table-cell ${FLOW_CLASS[group.flow] ?? "text-faint"}`}>
        {group.flow.charAt(0) + group.flow.slice(1).toLowerCase()}
      </td>
      <td className="hidden py-2 pr-3 text-right font-money text-[0.85rem] tabular md:table-cell">{group.total}</td>
      <td className="py-2">
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <select
            value={choice}
            disabled={locked}
            onChange={(e) => onChoose(e.target.value)}
            className="tap44 max-w-[130px] rounded-[2px] border border-rule bg-paper py-0.5 pl-1 pr-4 text-[0.78rem] text-ink md:max-w-[150px]"
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
              <option value={TRANSFER_TARGET}>Transfer (exclude)</option>
            </optgroup>
          </select>
          {choice === "" && !locked && (
            // Without a defer, a payee you cannot resolve sits at the top of
            // the queue forever and the queue stops feeling finishable.
            <button
              onClick={onSkip}
              className={`${CONTROL} tap44 border-rule text-faint hover:border-acc hover:text-acc`}
              title="Not now: hide this payee for the rest of this session. Nothing is written."
            >
              Skip
            </button>
          )}
          {choice !== "" && !locked && (
            // The count is the scope preview: this is the only place the size
            // of the write is stated before it happens.
            <button
              onClick={apply}
              className={`${CONTROL} tap44 border-acc bg-acc text-paper`}
              title={`Write a rule for "${group.key}" and categorize all ${group.count} as ${labelFor(choice)}`}
            >
              Apply to {group.count} →
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
 *
 * Each payee opens with its STRONG suggestion already chosen, so a long
 * backlog is read and confirmed: "Apply all" writes every payee with a choice
 * at once, the operator's own picks and the suggestions they left standing,
 * and one undo takes the whole batch back.
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
  const [applyingAll, startApplyAll] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The operator's explicit picks, "" included (cleared a suggestion). A
  // payee absent here falls back to its strong suggestion.
  const [picked, setPicked] = useState<Record<string, string>>({});
  // Session-scoped on purpose: a skip is "not now", not a decision, so it
  // must not outlive the sitting or quietly shrink the backlog for good.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [showSkipped, setShowSkipped] = useState(false);
  const visible = showSkipped ? groups : groups.filter((g) => !skipped.includes(g.key));

  const choiceOf = (g: PayeeGroupView) =>
    g.key in picked ? picked[g.key] : g.suggestion?.strength === "strong" ? g.suggestion.categoryId : "";
  const chosen = visible.filter((g) => choiceOf(g) !== "");
  const chosenRows = chosen.reduce((sum, g) => sum + g.count, 0);
  const busy = undoing || applyingAll;

  function applyAll() {
    setError(null);
    const batch = chosen.map((g) => ({ matchValue: g.key, matchField: g.matchField, target: choiceOf(g) }));
    startApplyAll(async () => {
      try {
        const result = await categorizeGroups(batch);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setPicked({});
        setLast({
          undo: result.undo,
          summary: `${plural(batch.length, "payee")} categorized: ${plural(result.recategorized, "transaction")} recategorized and a rule written for each payee.`,
        });
      } catch {
        setError(ACTION_DID_NOT_COMPLETE);
      }
    });
  }

  if (groups.length === 0 && last === null) {
    return (
      <p className="py-6 text-center text-[0.85rem] text-faint">
        Nothing left to review: every transaction has a category.
      </p>
    );
  }

  return (
    <>
      {last !== null && (
        <div className="flex flex-wrap items-center gap-3 border-b border-rule py-2 text-[0.78rem]">
          <span className="text-faint">{last.summary}</span>
          <button
            disabled={busy}
            onClick={() =>
              startUndo(async () => {
                try {
                  await undoCategorizeGroup(last.undo);
                  setLast(null);
                } catch {
                  setError(ACTION_DID_NOT_COMPLETE);
                }
              })
            }
            className={`${CONTROL} tap44 border-rule text-faint hover:border-acc hover:text-acc`}
            title="Restore every one of those transactions and remove the rules this created"
          >
            {undoing ? "Undoing…" : "Undo"}
          </button>
        </div>
      )}
      {chosen.length > 1 && (
        // The batch's size is stated before it is written, as a row's is.
        <div className="flex flex-wrap items-center gap-3 border-b border-rule py-2 text-[0.78rem]">
          <span className="text-faint">
            <span className="text-ink">{plural(chosen.length, "payee")}</span> have a category chosen (
            {plural(chosenRows, "transaction")}), suggestions included. Check them, change any, then apply them together;
            each is saved as a rule for that payee.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={applyAll}
            className={`${CONTROL} tap44 border-acc bg-acc text-paper`}
          >
            {applyingAll ? "Applying…" : `Apply all ${chosen.length} →`}
          </button>
        </div>
      )}
      {error !== null && <div className="py-1 text-[0.75rem] text-neg">{error}</div>}
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
          Nothing left to review: every transaction has a category.
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
                  scope="col"
                  key={h}
                  className={`py-1 pr-3 ${COLUMN_HEADER} ${
                    i === 0 || i === 3 ? "text-right" : "text-left"
                  } ${i === 2 || i === 3 ? "hidden md:table-cell" : ""}`}
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
                choice={choiceOf(g)}
                onChoose={(value) => setPicked((p) => ({ ...p, [g.key]: value }))}
                busy={busy}
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
