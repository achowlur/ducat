import type { NextRequest } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { SimplefinConnector } from "../../../../lib/connectors/simplefin";
import { isDemo } from "../../../../lib/demo/mode";
import { reseedDemo } from "../../../../lib/demo/reseed";
import { runSync } from "../../../../lib/sync/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily sync cron (Session 7). Vercel Cron GETs this with
 * `Authorization: Bearer ${CRON_SECRET}`. It pulls new SimpleFIN transactions
 * and regenerates insights via `runSync` — the sync window self-selects from
 * the `Setting` table, so no params are needed. No `prisma.$disconnect()`: the
 * warm singleton is reused across invocations. Middleware allow-lists
 * `/api/cron/*`, so this route does its own authorization.
 *
 * If insight regeneration ever exceeds the function budget, pass
 * `{ skipInsights: true }` here and run a separate insights cron.
 */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret === undefined || secret === "") {
    return new Response("CRON_SECRET is not configured.", { status: 503 });
  }
  const provided = request.headers.get("authorization") ?? "";
  if (!safeEqual(provided, `Bearer ${secret}`)) {
    return new Response("Unauthorized.", { status: 401 });
  }

  // The public demo has no feed: its nightly job puts the invented data back
  // as of today instead — undoing whatever visitors changed, and moving the
  // month being lived in forward so it is never empty.
  if (isDemo()) {
    try {
      const result = await reseedDemo(prisma, new Date());
      return Response.json({ ok: true, demo: "reseeded", ...result });
    } catch (e) {
      const error = e instanceof Error ? e.message : "reseed failed";
      return Response.json({ ok: false, error }, { status: 500 });
    }
  }

  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  if (accessUrl === undefined || accessUrl === "") {
    return Response.json({ ok: false, error: "SIMPLEFIN_ACCESS_URL is not configured." }, { status: 400 });
  }

  try {
    const result = await runSync(prisma, new SimplefinConnector(accessUrl), {});
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const error = e instanceof Error ? e.message : "sync failed";
    return Response.json({ ok: false, error }, { status: 500 });
  }
}
