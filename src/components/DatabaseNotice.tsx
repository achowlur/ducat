import { headers } from "next/headers";
import { isCloudMode } from "../lib/auth/mode";
import { databaseFailure, databaseTarget } from "../lib/ui/dbHealth";
import { DatabaseUnavailable } from "./DatabaseUnavailable";

/**
 * The guard every server-rendered page wraps its render in, so a database that
 * did not answer becomes a state that SAYS SO instead of the generic error
 * boundary — which shows the same "Something went wrong" for a null dereference.
 *
 * It sits at the PAGE rather than in app/error.tsx for two reasons that are not
 * matters of taste. First, in production Next replaces a server error's message
 * with a fixed sentence and a digest before the boundary ever sees it, so a
 * boundary cannot tell one failure from another (the same redaction is why
 * error.tsx's own `/not authenticated/` branch is dead on the deployment).
 * Second, the boundary is a client component: it cannot read DATABASE_URL or
 * `isCloudMode()`, and the honest advice differs between the two modes.
 *
 * Anything the classifier does not positively recognise is RETHROWN, so a real
 * bug still reaches the boundary and still looks like a bug. Trading one
 * indistinguishable failure for another would be no improvement.
 */
export async function withDatabaseNotice(
  render: () => Promise<React.ReactNode>,
): Promise<React.ReactNode> {
  try {
    return await render();
  } catch (error) {
    const failure = databaseFailure(error);
    if (failure === null) throw error;
    // Middleware stamps the resolved path AND the query on every request it
    // passes through. Both are needed: "Try again" has to re-ask the same
    // question, and on /transactions or /insights the question is almost
    // entirely in the query — retrying to a bare /transactions would drop the
    // reader's page, filters and payee queue without saying so.
    const requestHeaders = await headers();
    const path = requestHeaders.get("x-app-path") ?? "/";
    return (
      <DatabaseUnavailable
        failure={failure}
        cloud={isCloudMode()}
        target={databaseTarget(process.env.DATABASE_URL)}
        path={`${path}${requestHeaders.get("x-app-query") ?? ""}`}
      />
    );
  }
}
