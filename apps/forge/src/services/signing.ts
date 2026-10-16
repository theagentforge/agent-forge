// server_signature: HMAC-SHA256 over the stored report, so tampering in the database is detectable.

const enc = new TextEncoder();

export async function signReport(key: string, fields: Record<string, unknown>): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const canonical = JSON.stringify(fields, Object.keys(fields).sort());
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(canonical));
  return `hmac-sha256:${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
