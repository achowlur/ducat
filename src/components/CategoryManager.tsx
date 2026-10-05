"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { deleteCategory, renameCategory } from "../app/categories/actions";
import { ACTION_DID_NOT_COMPLETE } from "../lib/ui/boundaryCopy";
import { MAX_CATEGORY_NAME, normalizeCategoryName } from "../lib/categories";
import { CHIP, COLUMN_HEADER, CONTROL, FIELD_LABEL } from "./ui/headings";

export interface OwnCategory {
  id: string;
  name: string;
  isIncome: boolean;
  /** Transactions filed under it. */
  rows: number;
  /** Rules that set it. */
  rules: number;
  /** The ledger filtered to it; null when it holds no rows. */
  href: string | null;
}

export interface CategoryOption {
  id: string;
  name: string;
  isIncome: boolean;
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/** The select's value for "no category": never an id, which are cuids. */
const UNCATEGORIZED = "";

/**
 * The operator's own categories, each renamable and deletable in place. The
 * list owns the line that reports a finished delete, because the deleted row
 * itself is gone the moment the page revalidates.
 */
export function CategoryManager({ own, options }: { own: OwnCategory[]; options: CategoryOption[] }) {
  const [done, setDone] = useState<string | null>(null);

  if (own.length === 0) {
    return (
      <>
        {done !== null && <Done text={done} />}
        <p className="text-[0.85rem] text-faint">
          None yet. Type a name that matches no category into any row&apos;s category picker on the ledger,
          and it is offered as a new one.
        </p>
      </>
    );
  }

  return (
    <>
      {done !== null && <Done text={done} />}
      <table className="w-full border-collapse text-[0.85rem]">
        <thead>
          <tr className="border-b border-ink text-left">
            <th scope="col" className={`py-1.5 pr-3 ${COLUMN_HEADER}`}>
              Category
            </th>
            <th scope="col" className={`w-px py-1.5 pr-3 text-right ${COLUMN_HEADER}`}>
              Rows
            </th>
            <th scope="col" className={`w-px py-1.5 text-right ${COLUMN_HEADER}`}>
              Rules
            </th>
          </tr>
        </thead>
        <tbody>
          {own.map((c) => (
            <Row key={c.id} category={c} options={options.filter((o) => o.id !== c.id)} onDone={setDone} />
          ))}
        </tbody>
      </table>
    </>
  );
}

function Done({ text }: { text: string }) {
  return (
    <p role="status" className="mb-3 border-l-2 border-pos bg-chip px-3 py-2 text-[0.85rem]">
      {text}
    </p>
  );
}

function Row({
  category: c,
  options,
  onDone,
}: {
  category: OwnCategory;
  options: CategoryOption[];
  onDone: (text: string) => void;
}) {
  const [mode, setMode] = useState<"idle" | "rename" | "delete">("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const open = (next: "rename" | "delete") => {
    setFailure(null);
    setMode(next);
  };

  return (
    <>
      <tr className={mode === "delete" ? "" : "border-b border-rule"}>
        <td className="py-2 pr-3">
          {mode === "rename" ? (
            <RenameField
              category={c}
              pending={pending}
              failure={failure}
              onCancel={() => setMode("idle")}
              onSave={(name) => {
                setFailure(null);
                startTransition(async () => {
                  try {
                    const renamed = await renameCategory(c.id, name);
                    if (!renamed.ok) {
                      setFailure(renamed.message);
                      return;
                    }
                    setMode("idle");
                  } catch {
                    setFailure(ACTION_DID_NOT_COMPLETE);
                  }
                });
              }}
            />
          ) : (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 break-words">{c.name}</span>
                {/* Not on a category NAMED Income: there the chip only repeats the name. */}
                {c.isIncome && c.name.toLowerCase() !== "income" && (
                  <span className={`${CHIP} shrink-0 bg-chip text-acc`}>Income</span>
                )}
              </span>
              <span className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => open("rename")}
                  className={`${CONTROL} tap44 border-rule text-faint hover:border-acc hover:text-acc`}
                >
                  Rename
                </button>
                <button
                  type="button"
                  aria-expanded={mode === "delete"}
                  onClick={() => (mode === "delete" ? setMode("idle") : open("delete"))}
                  className={`${CONTROL} tap44 ${
                    mode === "delete" ? "border-neg bg-neg text-paper" : "border-rule text-faint hover:border-neg hover:text-neg"
                  }`}
                >
                  Delete
                </button>
              </span>
            </span>
          )}
        </td>
        <td className="py-2 pr-3 text-right font-money tabular">
          {c.href === null ? (
            c.rows
          ) : (
            <Link href={c.href} className="tap44 underline decoration-rule underline-offset-2 hover:text-acc">
              {c.rows.toLocaleString("en-US")}
            </Link>
          )}
        </td>
        <td className="py-2 text-right font-money tabular">{c.rules}</td>
      </tr>
      {mode === "delete" && (
        <tr className="border-b border-rule">
          <td colSpan={3} className="pb-3">
            <DeletePanel
              category={c}
              options={options}
              pending={pending}
              failure={failure}
              onCancel={() => setMode("idle")}
              onDelete={(moveTo) => {
                setFailure(null);
                startTransition(async () => {
                  try {
                    const deleted = await deleteCategory(c.id, moveTo);
                    if (!deleted.ok) {
                      setFailure(deleted.message);
                      return;
                    }
                    const into = options.find((o) => o.id === moveTo)?.name;
                    const rows = deleted.moved === 0 ? null : plural(deleted.moved, "row");
                    onDone(
                      into !== undefined
                        ? `Deleted “${deleted.name}”.${rows === null ? "" : ` ${rows} moved to ${into}.`}${
                            deleted.rulesMoved === 0
                            ? ""
                            : ` ${plural(deleted.rulesMoved, "rule")} now ${deleted.rulesMoved === 1 ? "sets" : "set"} ${into}.`
                          }`
                        : `Deleted “${deleted.name}”.${rows === null ? "" : ` ${rows} uncategorized again.`}${
                            deleted.rulesRemoved === 0 ? "" : ` ${plural(deleted.rulesRemoved, "rule")} removed.`
                          }`,
                    );
                  } catch {
                    setFailure(ACTION_DID_NOT_COMPLETE);
                  }
                });
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function RenameField({
  category: c,
  pending,
  failure,
  onSave,
  onCancel,
}: {
  category: OwnCategory;
  pending: boolean;
  failure: string | null;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(c.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  const typed = normalizeCategoryName(value);
  const unchanged = typed === null || typed === c.name;
  const save = () => {
    if (!pending && !unchanged) onSave(typed);
  };

  return (
    <span className="grid gap-1.5">
      <span className="flex flex-wrap items-center gap-1.5">
        <input
          ref={inputRef}
          type="text"
          value={value}
          maxLength={MAX_CATEGORY_NAME + 10}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            } else if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          aria-label={`New name for ${c.name}`}
          className="min-w-0 flex-1 rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.85rem] outline-none focus:border-acc max-md:min-h-[44px]"
        />
        <button
          type="button"
          aria-disabled={pending || unchanged}
          onClick={save}
          className={`${CONTROL} tap44 border-acc text-acc hover:bg-chip ${pending || unchanged ? "opacity-50" : ""}`}
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="tap44 text-[0.75rem] text-faint hover:text-ink">
          Cancel
        </button>
      </span>
      <span className={`text-[0.75rem] ${failure !== null ? "text-neg" : "text-faint"}`}>
        {failure ?? `Renames it everywhere: ${plural(c.rows, "row")} and ${plural(c.rules, "rule")} keep pointing at it.`}
      </span>
    </span>
  );
}

function DeletePanel({
  category: c,
  options,
  pending,
  failure,
  onDelete,
  onCancel,
}: {
  category: OwnCategory;
  options: CategoryOption[];
  pending: boolean;
  failure: string | null;
  onDelete: (moveTo: string | null) => void;
  onCancel: () => void;
}) {
  const pointedAt = c.rows > 0 || c.rules > 0;
  // An explicit choice, never a default, when anything points at it: the
  // write cannot be undone, and either default would be a guess.
  const [dest, setDest] = useState<string | null>(pointedAt ? null : UNCATEGORIZED);
  const into = dest === null || dest === UNCATEGORIZED ? null : (options.find((o) => o.id === dest)?.name ?? null);
  const spending = options.filter((o) => !o.isIncome);
  const income = options.filter((o) => o.isIncome);
  const what = [c.rows > 0 ? plural(c.rows, "row") : null, c.rules > 0 ? plural(c.rules, "rule") : null]
    .filter((x) => x !== null)
    .join(" and ");

  return (
    <div className="grid gap-2 border-l-2 border-neg bg-chip px-3 py-2 text-[0.85rem]">
      {pointedAt ? (
        <label className="grid gap-0.5">
          <span className={FIELD_LABEL}>Move its {what} to</span>
          <select
            value={dest ?? "choose"}
            onChange={(e) => setDest(e.target.value)}
            className="rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.85rem] max-md:min-h-[44px]"
          >
            <option value="choose" disabled>
              Choose where they go
            </option>
            <option value={UNCATEGORIZED}>Uncategorized</option>
            {spending.length > 0 && (
              <optgroup label="Spending">
                {spending.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </optgroup>
            )}
            {income.length > 0 && (
              <optgroup label="Income">
                {income.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      ) : (
        <p>Nothing is filed under it and no rule sets it.</p>
      )}
      {pointedAt && dest !== null && (
        <p className="text-faint">
          {into !== null
            ? `Its rows keep how they were categorized, now as ${into}${
                c.rules > 0 ? `, and ${c.rules === 1 ? "its rule sets" : "its rules set"} ${into} from now on` : ""
              }.`
            : `Its rows go back to Uncategorized and the review queue${
                c.rules > 0
                  ? `. A rule that sets only this category is removed; one that also marks a transfer keeps doing that`
                  : ""
              }.`}{" "}
          There is no undo.
        </p>
      )}
      <span className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-disabled={pending || dest === null}
          onClick={() => {
            if (!pending && dest !== null) onDelete(dest === UNCATEGORIZED ? null : dest);
          }}
          className={`${CONTROL} tap44 border-neg text-neg hover:bg-neg hover:text-paper ${
            pending || dest === null ? "opacity-50" : ""
          }`}
        >
          {pending ? "Deleting…" : `Delete “${c.name}”`}
        </button>
        <button type="button" onClick={onCancel} className="tap44 text-[0.75rem] text-faint hover:text-ink">
          Cancel
        </button>
      </span>
      {failure !== null && (
        <p role="alert" className="text-neg">
          {failure}
        </p>
      )}
    </div>
  );
}
