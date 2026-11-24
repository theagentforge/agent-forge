import { injectionSignals } from "@forge/shared";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import * as t from "../db/schema";
import { getDb, type Db } from "../services/db";
import { isAdmin } from "../services/identity";
import { currentSession } from "./dashboard";
import { site } from "./pages";

// ADR 0157: a read-only check of notes already on file. Lists approved notes that match the injection patterns
// (noteNeedsReview), and notes held for review, so the founder can decide on each after the release. It never writes:
// releasing or removing a note stays a manual D1 update (the ADR says how). Founders only, JSON, never cached.

type Ctx = Context<{ Bindings: Env }>;
export const ADMIN_NOTE_REVIEW_PATH = "/admin/note-review.json";
/** Notes read per request (newest first); the answer says when there were more. */
export const NOTE_REVIEW_LIMIT = 5000;

export async function noteReview(db: Db, limit = NOTE_REVIEW_LIMIT) {
  const rows = await db
    .select({ id: t.reports.id, note: t.reports.note, state: t.reports.moderationState, createdAt: t.reports.createdAt, tool: t.tools.canonicalId })
    .from(t.reports)
    .innerJoin(t.toolVersions, eq(t.toolVersions.id, t.reports.toolVersionId))
    .innerJoin(t.tools, eq(t.tools.id, t.toolVersions.toolId))
    .where(and(isNotNull(t.reports.note)))
    .orderBy(desc(t.reports.createdAt))
    .limit(limit + 1);
  const read = rows.slice(0, limit);
  const view = (r: (typeof rows)[number]) => ({ report_id: r.id, tool: r.tool, created_at: new Date(r.createdAt).toISOString(), state: r.state, rules: injectionSignals(r.note ?? ""), note: r.note });
  const approved = read.filter((r) => r.state === "approved");
  return {
    data_kind: "forge_note_review",
    read_only: true,
    notes_read: read.length,
    more_not_read: rows.length > limit,
    approved_read: approved.length,
    approved_matching: approved.map(view).filter((r) => r.rules.length),
    held_for_review: read.filter((r) => r.state === "review").map(view),
  };
}

site.get(ADMIN_NOTE_REVIEW_PATH, async (c: Ctx) => {
  const s = await currentSession(c);
  const me = s ? await getDb(c.env).query.humans.findFirst({ where: eq(t.humans.id, s.session.h) }) : null;
  if (!me || !isAdmin(c.env, me.githubId)) return c.json({ error: "not_found" }, 404, { "Cache-Control": "no-store" });
  return c.json(await noteReview(getDb(c.env)), 200, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
});
