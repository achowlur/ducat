import { cronSummary, getProvidersData, STATUS_CHIP, STATUS_DOT } from "../../lib/ui/providers";
import { dateTime } from "../../lib/ui/format";
import { isCloudMode } from "../../lib/auth/mode";
import vercelConfig from "../../../vercel.json";
import { PageTitle, SectionTitle, SubsectionTitle } from "../../components/ui/headings";

export const dynamic = "force-dynamic";

const CRON_SCHEDULE = vercelConfig.crons[0].schedule;

/**
 * What cloud mode costs you, in the operator's own words from DEPLOY.md.
 *
 * Kept HERE rather than in providers.ts's trust cards because those are
 * per-CONNECTOR — this is a property of where the data rests, which is the one
 * claim the connectors deliberately do not make.
 */
const CLOUD_RESIDUAL_RISKS = [
  "Turso encrypts at rest, but it can read your data while serving queries. Encryption at rest is not encryption from the operator of the database.",
  "This is not end-to-end encryption. Client-side keys, with the analyzers running in your browser, are deliberately deferred — so “we can't read it even if breached” is not a claim this deployment can make.",
  "The password gate is the whole perimeter. Anyone who has it has the data, and the app has no second factor.",
  "If that trade-off is not acceptable, local mode is unchanged and takes the data back onto your own machine.",
];

export default async function ProvidersPage() {
  const providers = await getProvidersData();
  const cloud = isCloudMode();

  return (
    <div className="grid gap-10 py-5">
      <PageTitle>Providers</PageTitle>
      {/* Where the data RESTS, which the per-connector cards deliberately do not
          claim. They were written when localhost was the only mode and said
          things like "fully local; no third party involved" — true then, false
          from a cloud deployment, and a trust page that is confidently wrong is
          worse than one that says nothing. */}
      <section className="border-l-2 border-acc bg-chip px-3 py-2.5">
        <SectionTitle>This instance</SectionTitle>
        <p className="text-[0.82rem] leading-relaxed">
          {cloud ? (
            <>
              Running in <strong>cloud mode</strong>, against your own Turso database on your own Vercel
              project. Your transaction data rests there rather than on this device — single-tenant
              infrastructure you control and pay for, not a shared service, so no third party custodies it.
              A password gate is what stands between it and the internet, and it is required: deployed
              without one, the app refuses to serve.
            </>
          ) : (
            <>
              Running in <strong>local mode</strong>, against a file database on this machine, bound to
              127.0.0.1. Transaction data never leaves this device — the only outbound connections the
              app makes are the ones on this page: the SimpleFIN feed, plus the FRED rate index only if
              you opt in with an API key. Nothing outbound carries transaction data.
            </>
          )}{" "}
          {/* "How often" was unanswerable from this page — the words schedule,
              cron and nightly appeared zero times — while the FRED card's own
              risk line referred to "your sync times". Read from vercel.json so
              the sentence cannot drift from the cron that fires. */}
          {cloud ? (
            <>
              It syncs automatically {cronSummary(CRON_SCHEDULE)}, and whenever you press Sync now on
              Overview.
            </>
          ) : (
            <>Nothing is scheduled here: a local instance syncs when you run a sync, and not otherwise.</>
          )}
        </p>

        {/* Every connector below carries three parts — data path, residual
            risks, revocation — and this block, the one describing where the
            data actually RESTS, carried only the reassuring half. DEPLOY.md
            leads with the counterweight and none of it reached the page: the
            words "encrypt", "end-to-end" and "read your data" appeared zero
            times. An addition, never a softening — the sentence above is
            CLAUDE.md's own claim and is correct; what was missing is what you
            accept by believing it. */}
        {cloud && (
          <div className="mt-3">
            <SubsectionTitle>Residual risks you are accepting</SubsectionTitle>
            <ul className="grid gap-2">
              {CLOUD_RESIDUAL_RISKS.map((risk, i) => (
                <li key={risk} className="flex gap-2 text-[0.8rem] leading-relaxed">
                  <span className="font-money text-faint">{i + 1}.</span>
                  <span>{risk}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {providers.map(({ health, configured, setupHint, syncLogs }) => (
        <section key={health.connectorType}>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b-2 border-ink pb-2">
            {/* The connector NAME is the heading its parts belong under. It
                was a plain span, so navigating by heading gave "Residual risks
                you are accepting" three times with nothing naming which
                connector owned them. */}
            <h2 className="text-[1rem] font-semibold">
              <span
                className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[health.status] ?? STATUS_DOT.UNKNOWN}`}
              />
              {health.trustCard.displayName}
            </h2>
            <span
              className={`rounded-[2px] px-1.5 py-0.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] ${
                STATUS_CHIP[health.status] ?? STATUS_CHIP.UNKNOWN
              }`}
            >
              {health.status}
            </span>
            {/* The unit is per-connector. One template printed "0 accounts"
                over a CSV importer that had brought in 2128 transactions (it
                targets EXISTING accounts, so its own account count is
                correctly zero and semantically useless) and over a rate index
                that will never have an account at all. FRED does not "sync"
                either — health.ts calls its own value the last successful
                FETCH while the page printed the word sync over it. */}
            <span className="text-[0.78rem] text-faint">
              {health.connectorType === "FRED"
                ? health.lastSuccessfulSyncAt === null
                  ? "no observation stored"
                  : `latest observation fetched ${dateTime(health.lastSuccessfulSyncAt)}`
                : health.connectorType === "CSV"
                  ? health.lastSuccessfulSyncAt === null
                    ? "no imports yet"
                    : `last import ${dateTime(health.lastSuccessfulSyncAt)}`
                  : `${health.accountCount} account${health.accountCount === 1 ? "" : "s"}${
                      health.lastSuccessfulSyncAt === null
                        ? ""
                        : ` · last successful sync ${dateTime(health.lastSuccessfulSyncAt)}`
                    }`}
            </span>
          </div>

          <div className="grid gap-6 pt-3 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="lg:col-start-1 lg:row-start-1">
              <SubsectionTitle>Signals</SubsectionTitle>
              <ul className="grid gap-1 text-[0.85rem]">
                {health.reasons.map((reason) => (
                  <li key={reason} className="flex gap-2">
                    <span className="text-faint">—</span>
                    <span className={health.status === "ERROR" ? "font-semibold text-neg" : ""}>{reason}</span>
                  </li>
                ))}
              </ul>

              {setupHint !== null && (
                <div className="mt-3 border-l-2 border-acc bg-chip px-3 py-2">
                  <SubsectionTitle>Set up</SubsectionTitle>
                  <code className="block whitespace-pre-wrap font-money text-[0.75rem] leading-relaxed">
                    {setupHint}
                  </code>
                </div>
              )}
              {health.connectorType === "SIMPLEFIN" && (
                <p className="mt-3 text-[0.75rem] text-faint">
                  Access URL: {configured ? "configured" : "not configured"} — read from{" "}
                  {cloud ? "the platform's environment variables" : ".env on this machine"}, and never
                  displayed.
                </p>
              )}
              {health.connectorType === "FRED" && (
                <p className="mt-3 text-[0.75rem] text-faint">
                  API key: {configured ? "configured" : "not configured"} — read from{" "}
                  {cloud ? "the platform's environment variables" : ".env on this machine"}, and never
                  displayed. Absent, the fetch does not run at all.
                </p>
              )}

            </div>

            <div className="border-rule lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:border-l lg:pl-6">
              <SubsectionTitle>Data path</SubsectionTitle>
              <p className="mb-4 text-[0.82rem] leading-relaxed">{health.trustCard.dataPath}</p>

              <SubsectionTitle>Residual risks you are accepting</SubsectionTitle>
              <ul className="mb-4 grid gap-2">
                {health.trustCard.residualRisks.map((risk, i) => (
                  <li key={risk} className="flex gap-2 text-[0.8rem] leading-relaxed">
                    <span className="font-money text-faint">{i + 1}.</span>
                    <span>{risk}</span>
                  </li>
                ))}
              </ul>

              <SubsectionTitle>Revocation</SubsectionTitle>
              <p className="text-[0.8rem] leading-relaxed">{health.trustCard.revocation}</p>
            </div>

            {/* LAST in the DOM, so a phone reads status, then the trust card,
                then the log. It used to sit above the trust card inside the
                left column, which on a phone meant 1,799px of sync-log rows —
                2.22 screens — between "All signals normal" and the words "Data
                path". The log is a record you consult; the trust card is what
                the page is FOR, and DEPLOY.md calls the cloud deployment "the
                one on your phone". Desktop is unchanged: explicit placement
                puts it back under Signals in the left column. */}
            <div className="lg:col-start-1 lg:row-start-2">
                  <SubsectionTitle>Sync history {syncLogs.length > 0 && `(last ${syncLogs.length})`}</SubsectionTitle>
                  {syncLogs.length === 0 ? (
                    <p className="text-[0.8rem] text-faint">No syncs recorded yet.</p>
                  ) : (
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="border-b border-ink">
                          {["When", "Outcome", "Imported", "Skipped", "Rules", "Transfers"].map((h, i) => (
                            <th
                              scope="col"
                              key={h}
                              className={`py-1 text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-faint ${
                                i < 2 ? "text-left" : "text-right"
                              }`}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {syncLogs.map((log) => (
                          <tr key={log.id} className="border-b border-rule last:border-b-0">
                            <td className="py-1 pr-3 font-money text-[0.75rem] tabular text-faint">
                              {dateTime(log.finishedAt)}
                            </td>
                            <td className="py-1 pr-3 text-[0.78rem]">
                              {log.ok ? (
                                <span className="font-semibold text-pos">ok</span>
                              ) : (
                                <span className="font-semibold text-neg" title={log.errorText ?? undefined}>
                                  failed{log.errorText !== null && ` — ${log.errorText}`}
                                </span>
                              )}
                              {log.feedErrors.length > 0 && (
                                <span className="block text-[0.7rem] text-faint">
                                  {log.feedErrors.join(" · ")}
                                </span>
                              )}
                            </td>
                            <td className="py-1 pr-3 text-right font-money text-[0.78rem] tabular">
                              {log.transactionsImported}
                            </td>
                            <td className="py-1 pr-3 text-right font-money text-[0.78rem] tabular text-faint">
                              {log.transactionsSkipped}
                            </td>
                            <td className="py-1 pr-3 text-right font-money text-[0.78rem] tabular text-faint">
                              {log.rulesApplied}
                            </td>
                            <td className="py-1 text-right font-money text-[0.78rem] tabular text-faint">
                              {log.transfersLinked}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
