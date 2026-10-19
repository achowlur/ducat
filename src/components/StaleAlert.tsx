import { ActionAlert, ALERT_ACTION } from "./ActionAlert";
import { staleAction, type StaleCandidate } from "../lib/ui/staleAction";

/** The stale-account nudge: one alert for every SimpleFIN account behind, nothing when none is. */
export function StaleAlert({ accounts }: { accounts: StaleCandidate[] }) {
  const action = staleAction(accounts);
  if (action === null) return null;
  return (
    <ActionAlert
      kind="Stale"
      actions={
        <a className={ALERT_ACTION} href={action.href} rel="noreferrer">
          Reconnect
        </a>
      }
    >
      {action.sentence}
    </ActionAlert>
  );
}
