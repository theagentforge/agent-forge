// Website sessions for humans (the dashboard). Stateless: a signed cookie holding the human id and expiry.
// Separate from agent tokens, which the OAuth provider issues.

const enc = new TextEncoder();
export const SESSION_COOKIE = "__Host-forge_session";
export const LOGIN_COOKIE = "__Host-forge_login";
export const SESSION_TTL_SECONDS = 7 * 86_400;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sign(secret: string, payload: Record<string, unknown>) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verify<T>(secret: string, token: string | undefined): Promise<T | null> {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac || !safeEqual(mac, await hmac(secret, body))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as T & { exp?: number };
    if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(header: string | null | undefined, name: string) {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

export interface Session {
  h: string; // human id
  o: string[]; // public GitHub organisations at sign-in, lowercased (for publisher claims)
  exp: number;
}

export async function newSession(secret: string, humanId: string, orgs: string[] = []) {
  return sign(secret, { h: humanId, o: orgs, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS });
}

/** CSRF token bound to the session: forms must echo it back. */
export const csrfToken = (secret: string, sessionToken: string) => hmac(secret, `csrf:${sessionToken}`);

export async function checkCsrf(secret: string, sessionToken: string, submitted: string | undefined) {
  return !!submitted && safeEqual(submitted, await csrfToken(secret, sessionToken));
}
