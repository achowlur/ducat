"use client";

import { useRef, useState, useTransition } from "react";
import { renameAccount, setHiddenOnOverview } from "../app/accounts/actions";
import { refuse } from "../lib/actionResult";
import { MAX_ACCOUNT_NAME } from "../lib/accountDisplay";
import { ACTION_DID_NOT_COMPLETE } from "../lib/ui/boundaryCopy";
import { CONTROL } from "./ui/headings";

/**
 * An account's two display choices on /accounts (lib/accountDisplay.ts): its
 * name as the reader knows it, and whether Overview's table lists it. Neither
 * touches a figure. Rename opens in place; Escape or Cancel leaves without
 * saving, and focus returns to the control that opened it. A refusal is said
 * beside the control, in the action's own words.
 */
export function AccountDisplayControls({
  accountId,
  feedName,
  typedName,
  hiddenOnOverview,
}: {
  accountId: string;
  feedName: string;
  typedName: string | null;
  hiddenOnOverview: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(typedName ?? "");
  const [refusal, setRefusal] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const run = (call: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) => {
    if (pending) return;
    setRefusal(null);
    startTransition(async () => {
      const result = await call().catch(() => refuse(ACTION_DID_NOT_COMPLETE));
      if (!result.ok) setRefusal(result.message ?? ACTION_DID_NOT_COMPLETE);
      else after?.();
    });
  };
  const close = () => {
    setEditing(false);
    setDraft(typedName ?? "");
    opener.current?.focus();
  };

  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.72rem]">
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => renameAccount(accountId, draft), () => setEditing(false));
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            }
          }}
        >
          <label className="sr-only" htmlFor={`name-${accountId}`}>
            Name for {feedName}
          </label>
          <input
            id={`name-${accountId}`}
            autoFocus
            value={draft}
            maxLength={MAX_ACCOUNT_NAME}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={feedName}
            className="w-48 rounded-[2px] border border-rule bg-paper px-1.5 py-1 text-[0.8rem] text-ink max-md:min-h-[44px]"
          />
          <button type="submit" aria-disabled={pending} className={`tap44 ${CONTROL} border-ink ${pending ? "opacity-50" : ""}`}>
            Save
          </button>
          {typedName !== null && (
            <button
              type="button"
              aria-disabled={pending}
              onClick={() => run(() => renameAccount(accountId, ""), () => setEditing(false))}
              className={`tap44 ${CONTROL} border-rule text-faint hover:text-ink`}
            >
              Use the bank&apos;s name
            </button>
          )}
          <button type="button" onClick={close} className="tap44 px-1 text-faint hover:text-ink">
            Cancel
          </button>
        </form>
      ) : (
        <button
          ref={opener}
          type="button"
          onClick={() => setEditing(true)}
          className="tap44 text-acc hover:underline"
          aria-label={`Rename ${typedName ?? feedName}`}
        >
          Rename
        </button>
      )}
      <label className="tap44 inline-flex cursor-pointer items-center gap-1.5 text-faint">
        <input
          type="checkbox"
          checked={hiddenOnOverview}
          disabled={pending}
          onChange={(e) => {
            const hide = e.target.checked;
            run(() => setHiddenOnOverview(accountId, hide));
          }}
          className="accent-acc"
        />
        Hide on Overview
      </label>
      {typedName !== null && !editing && <span className="text-faint">Bank&apos;s name: {feedName}</span>}
      {refusal !== null && (
        <span role="alert" className="flex max-w-[220px] items-start gap-1">
          <span className="text-neg">{refusal}</span>
          <button type="button" onClick={() => setRefusal(null)} className="tap44 shrink-0 px-1 text-faint hover:text-ink" aria-label="Dismiss this message">
            ×
          </button>
        </span>
      )}
    </span>
  );
}
