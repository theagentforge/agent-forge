import { eq } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { isAdmin } from "../services/identity";
import { currentSession } from "./dashboard";
import type { Context } from "hono";

// The release switch for the validity pack (ADR 0136; review 5 Nov). Dinike hasn't yet approved publishing
// /benchmark/validity, its files, the error record or the trap pages' "Dispute and correction history" section, and
// four published verdicts are known wrong pending a re-score (ADR 0140). Until VALIDITY_PUBLIC is "on", every one of
// those answers 404 (or is left off the page) for everyone but a signed-in admin, who sees it uncached ("private,
// no-store") as a preview. Off by default: an unset or any other value is off.

export const validityReleased = (env: { VALIDITY_PUBLIC?: string }) => (env.VALIDITY_PUBLIC ?? "").trim().toLowerCase() === "on";

/** Who may see the validity pack on this request: everyone once released, otherwise only a signed-in admin. */
export async function validityAccess(c: Context<{ Bindings: Env }>): Promise<"public" | "admin_preview" | null> {
  if (validityReleased(c.env)) return "public";
  const s = await currentSession(c).catch(() => null);
  if (!s) return null;
  const me = await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) });
  return me && isAdmin(c.env, me.githubId) ? "admin_preview" : null;
}

/** Headers for an admin's preview of unreleased material: never cached anywhere, never indexed. */
export const PREVIEW_HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" } as const;

/** Marks a response as an admin preview (uncached, unindexed). */
export function asPreview(res: Response) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(PREVIEW_HEADERS)) out.headers.set(k, v);
  return out;
}
