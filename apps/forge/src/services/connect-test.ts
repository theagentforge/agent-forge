import type { CheckQuery } from "@forge/shared";

// The "Test it" step on /connect (ADR 0017 §4): the page shows a one-time code, the visitor asks their AI to check
// `npm:forge-test-<code>`, and the page ticks when that check arrives, from any app. Only the code is stored, for an hour.

export const TEST_ID = /^npm:forge-test-([a-z0-9]{6})$/;
const key = (code: string) => `connect-test:${code}`;

export const newTestCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

/** Called from every check path. True when the check was a connect test (it is then not a real tool check). */
export async function markConnectTest(env: Pick<Env, "KV">, q: CheckQuery): Promise<boolean> {
  const m = q.id ? TEST_ID.exec(q.id.trim().toLowerCase()) : null;
  if (!m) return false;
  await env.KV.put(key(m[1]!), "1", { expirationTtl: 3600 });
  return true;
}

export async function connectTestSeen(env: Pick<Env, "KV">, code: string) {
  return /^[a-z0-9]{6}$/.test(code) && (await env.KV.get(key(code))) === "1";
}
