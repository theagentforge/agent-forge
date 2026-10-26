import type { CheckQuery } from "@forge/shared";
import { bump } from "./usage";

// The "Test it" step on /connect (ADR 0017 §4): the page shows a one-time code, the visitor asks their AI to check
// `npm:forge-test-<code>`, and the page ticks when that check arrives, from any app. Only the code is stored, for an hour.

export const TEST_ID = /^npm:forge-test-([a-z0-9]{6})$/;
const key = (code: string) => `connect-test:${code}`;
const CODE = /^[a-z0-9]{6}$/;

export const newTestCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

/** The path a check came in by, counted as `connect:test-passed:<channel>` (ADR 0050). */
export type TestChannel = "mcp" | "mcp-signed-in" | "api" | "a2a" | "web";

/**
 * The test code in a check, however the AI wrote the id (issue #224): `npm:forge-test-<code>` as shown, in any case,
 * with spaces after `npm:`, without the `npm:` prefix, with an inline version (`@latest`, `@1.0.0`), with a trailing
 * full stop or quote, or as the package's npmjs.com page. Null for anything else.
 */
export function testCodeOf(q: Pick<CheckQuery, "id" | "url">): string | null {
  const raw = (q.id ?? q.url ?? "").trim().toLowerCase().slice(0, 200);
  if (!raw) return null;
  let s = raw.replace(/^["'`]+|["'`.,;:!?)\]]+$/g, "");
  const page = /^https?:\/\/(?:www\.)?npmjs\.(?:com|org)\/package\/(forge-test-[a-z0-9]{6})(?:\/v\/[^/?#]+)?\/?(?:[?#].*)?$/.exec(s);
  if (page) s = page[1]!;
  s = s.replace(/^npm:\s*/, "").replace(/@[a-z0-9.^~*-]*$/, "");
  const m = /^forge-test-([a-z0-9]{6})$/.exec(s);
  return m ? m[1]! : null;
}

/**
 * Called from every check path. True when the check was a connect test (it is then not a real tool check). The first
 * check from an AI (any path but the web check form) is one person finishing /connect, the conversion we optimise:
 * counted once per code as `connect:test-passed`. A check typed into the site's own check form also ticks the page,
 * but counts only as `connect:test-passed:web`, since no AI app was involved.
 */
export async function markConnectTest(env: Env, q: Pick<CheckQuery, "id" | "url">, channel: TestChannel = "api"): Promise<boolean> {
  const code = testCodeOf(q);
  if (!code) return false;
  const before = await env.KV.get(key(code));
  const ai = channel !== "web";
  if (before !== "1") {
    // Daily counts only; never anything about who checked.
    const keys = ai ? ["connect:test-passed", `connect:test-passed:${channel}`] : before === null ? ["connect:test-passed:web"] : [];
    if (keys.length) await bump(env, keys).catch(() => {});
    // "1": an AI's check arrived. "web": only the site's form so far, so a later AI check still counts.
    await env.KV.put(key(code), ai ? "1" : "web", { expirationTtl: 3600 });
  } else await env.KV.put(key(code), "1", { expirationTtl: 3600 });
  return true;
}

export async function connectTestSeen(env: Pick<Env, "KV">, code: string) {
  if (!CODE.test(code)) return false;
  const v = await env.KV.get(key(code));
  return v === "1" || v === "web";
}
