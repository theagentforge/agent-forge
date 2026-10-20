// The Forge's agent on Moltbook (www.moltbook.com, the social network for AI agents). Posting is approve-only: an admin
// approves a `moltbook` issue, the moltbook.yml workflow sends the approved post here with its GitHub OIDC token, and
// the Worker posts it with the Moltbook key, which lives only in Cloudflare secrets. Moltbook asks new content to pass
// a short, scrambled arithmetic question (its anti-spam check for AI agents): a Workers AI model reads the question
// into two numbers and an operation, and this code does the arithmetic. One post per approval, no comments, votes,
// follows or messages, so nothing here can turn into spam (Moltbook rules.md: "Quality over quantity").

export const MOLTBOOK_API = "https://www.moltbook.com/api/v1";
export const CHALLENGE_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const POSTED_TTL = 365 * 86_400;
/** Moltbook's own limits (rules.md): one post per 30 minutes, one per 2 hours in an agent's first day. */
export const POST_GAP_MS = 30 * 60_000;
export const NEW_AGENT_GAP_MS = 2 * 3_600_000;
const NEW_AGENT_MS = 24 * 3_600_000;

export interface MoltbookPost {
  submolt: string;
  title: string;
  content: string;
}

/** The same rules Moltbook states, checked before anything is sent. */
export function validatePost(p: unknown): MoltbookPost | string {
  const o = p as Partial<MoltbookPost> | null;
  if (!o || typeof o !== "object") return "post must be an object";
  if (typeof o.submolt !== "string" || !/^[a-z0-9-]{2,30}$/.test(o.submolt)) return "submolt must be 2–30 lowercase letters, digits or hyphens";
  if (typeof o.title !== "string" || !o.title.trim() || o.title.length > 300) return "title must be 1–300 characters";
  if (typeof o.content !== "string" || !o.content.trim() || o.content.length > 40_000) return "content must be 1–40,000 characters";
  return { submolt: o.submolt, title: o.title.trim(), content: o.content.trim() };
}

/** The challenge without its noise: symbols dropped, case folded, so the model sees plain words. */
export const cleanChallenge = (text: string) =>
  text
    .replace(/[^a-zA-Z0-9.,?\s-]/g, "")
    .replace(/(?<=[a-zA-Z])-(?=[a-zA-Z])/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function compute(a: number, op: string, b: number): string | null {
  const v = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : op === "/" && b !== 0 ? a / b : NaN;
  return Number.isFinite(v) ? v.toFixed(2) : null;
}

/** Reads the question with Workers AI (two numbers, one operation) and computes the answer in code. */
export async function solveChallenge(ai: Ai, challenge: string): Promise<string | null> {
  const out = (await ai.run(CHALLENGE_MODEL as keyof AiModels, {
    messages: [
      {
        role: "system",
        content:
          'The user message is an arithmetic word problem with misspelled number words (for example "twennty" means 20). Reply with JSON only: {"a": <first number>, "op": "+" | "-" | "*" | "/", "b": <second number>}. No other text.',
      },
      { role: "user", content: cleanChallenge(challenge) },
    ],
    temperature: 0,
    max_tokens: 60,
  } as never)) as { response?: unknown };
  const text = typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? "");
  const m = /\{[^}]*\}/.exec(text);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { a?: unknown; op?: unknown; b?: unknown };
    return typeof j.a === "number" && typeof j.b === "number" && typeof j.op === "string" ? compute(j.a, j.op, j.b) : null;
  } catch {
    return null;
  }
}

const hashOf = async (p: MoltbookPost) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([p.submolt, p.title, p.content]))))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);

export type PostOutcome =
  | { ok: true; post_id: string; url: string; verified: boolean; already?: boolean }
  | { ok: false; error: string; status?: number };

/** Posts once per approved text (a repeat of the same post is never sent twice), then answers the challenge if asked. */
export async function postToMoltbook(env: Env & { MOLTBOOK_API_KEY?: string }, post: MoltbookPost, fetcher: typeof fetch = fetch): Promise<PostOutcome> {
  const key = env.MOLTBOOK_API_KEY;
  if (!key) return { ok: false, error: "moltbook_not_connected" };
  const hash = await hashOf(post);
  const seen = await env.KV.get<{ post_id: string; url: string }>(`moltbook:posted:${hash}`, "json");
  if (seen) return { ok: true, ...seen, verified: true, already: true };
  const now = Date.now();
  const first = Number((await env.KV.get("moltbook:first-post")) ?? 0);
  const last = Number((await env.KV.get("moltbook:last-post")) ?? 0);
  const gap = first && now - first < NEW_AGENT_MS ? NEW_AGENT_GAP_MS : POST_GAP_MS;
  if (last && now - last < gap) return { ok: false, error: `too_soon: Moltbook allows one post per ${gap / 60_000} minutes; try after ${new Date(last + gap).toISOString()}` };
  const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const res = await fetcher(`${MOLTBOOK_API}/posts`, { method: "POST", headers: auth, body: JSON.stringify({ submolt_name: post.submolt, title: post.title, content: post.content }) });
  const body = (await res.json().catch(() => ({}))) as {
    post?: { id?: string; verification?: { verification_code?: string; challenge_text?: string } };
    verification_required?: boolean;
    error?: string;
    retry_after_minutes?: number;
  };
  if (!res.ok || !body.post?.id) return { ok: false, error: String(body.error ?? "moltbook_refused").slice(0, 200), status: res.status };
  const id = body.post.id;
  await env.KV.put("moltbook:last-post", String(now), { expirationTtl: 7 * 86_400 });
  if (!first) await env.KV.put("moltbook:first-post", String(now));
  const url = `https://www.moltbook.com/post/${id}`;
  let verified = true;
  const v = body.post.verification;
  if (body.verification_required && v?.verification_code && v.challenge_text) {
    const answer = await solveChallenge(env.AI, v.challenge_text);
    verified = false;
    if (answer) {
      const r = await fetcher(`${MOLTBOOK_API}/verify`, { method: "POST", headers: auth, body: JSON.stringify({ verification_code: v.verification_code, answer }) });
      verified = r.ok && ((await r.json().catch(() => ({}))) as { success?: boolean }).success === true;
    }
  }
  // Recorded even when unverified: the post exists (hidden until verified), and re-sending would create a duplicate.
  await env.KV.put(`moltbook:posted:${hash}`, JSON.stringify({ post_id: id, url }), { expirationTtl: POSTED_TTL });
  return { ok: true, post_id: id, url, verified };
}
