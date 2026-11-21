"use client";

import { useState, useTransition } from "react";
import { dismissReconnectedAccount, mergeReconnectedAccount } from "../app/accounts/actions";
import { refuse } from "../lib/actionResult";
import { ACTION_DID_NOT_COMPLETE } from "../lib/ui/boundaryCopy";
import type { RelinkOffer } from "../lib/ui/accounts";
import { ActionAlert, ALERT_ACTION } from "./ActionAlert";

/**
 * One offer to re-link an account a reconnect forked (lib/sync/relink.ts).
 * Nothing merges until Merge is pressed; "Not the same" stops the offer for
 * good. What the merge did, or why it was refused, is said in place.
 */
function Offer({ offer }: { offer: RelinkOffer }) {
  const [pending, startTransition] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; message: string } | null>(null);
  const run = (call: () => Promise<{ ok: boolean; message?: string }>, done: string) => {
    if (pending) return;
    setSaid(null);
    startTransition(async () => {
      const result = await call().catch(() => refuse(ACTION_DID_NOT_COMPLETE));
      setSaid(result.ok ? { ok: true, message: result.message ?? done } : { ok: false, message: result.message ?? ACTION_DID_NOT_COMPLETE });
    });
  };
  if (said?.ok === true) {
    return (
      <p role="status" className="border-l-4 border-rule bg-chip px-3 py-2.5 text-[0.85rem]">
        {said.message}
      </p>
    );
  }
  return (
    <ActionAlert
      kind="Reconnected"
      wrapActions
      detail={
        <>
          Merging keeps the older account and everything on it (categories, transfer links, tags), moves in the new
          one&apos;s rows, and drops the copies of rows it already holds.
          {said !== null && (
            <span role="alert" className="mt-1 block text-warn-ink">
              {said.message}
            </span>
          )}
        </>
      }
      actions={
        <>
          <button
            type="button"
            aria-disabled={pending}
            className={`${ALERT_ACTION} ${pending ? "opacity-50" : ""}`}
            onClick={() => run(() => mergeReconnectedAccount(offer.oldId, offer.newId), "Merged.")}
          >
            Merge
          </button>
          <button
            type="button"
            aria-disabled={pending}
            className={`${ALERT_ACTION} font-normal ${pending ? "opacity-50" : ""}`}
            onClick={() => run(() => dismissReconnectedAccount(offer.oldId, offer.newId), "This pair will not be offered again.")}
          >
            Not the same
          </button>
        </>
      }
    >
      {offer.institution} {offer.newName} appeared as a new account, and the older {offer.oldName} stopped updating{" "}
      {offer.oldAsOf}. The same account after a reconnect?
    </ActionAlert>
  );
}

export function RelinkAlert({ offers }: { offers: RelinkOffer[] }) {
  if (offers.length === 0) return null;
  return (
    <div className="grid gap-2">
      {offers.map((o) => (
        <Offer key={`${o.oldId}|${o.newId}`} offer={o} />
      ))}
    </div>
  );
}
