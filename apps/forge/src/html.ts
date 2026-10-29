// Minimal server-rendered pages for the sign-in flow. Everything interpolated is escaped.

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'";

export function page(title: string, body: string, headers = new Headers(), status = 200): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · The Agent Forge</title>
<style>
:root{color-scheme:dark;--bg:#0B0E12;--surface:#131820;--seam:#2A3340;--text:#E8ECF1;--muted:#9AA5B4;--brand:#4AA8FF;--on-brand:#0B0E12;--caution:#F5B83D}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#F7F8FA;--surface:#FFFFFF;--seam:#D5DBE3;--text:#0E1116;--muted:#4B5563;--brand:#1060D0;--on-brand:#FFFFFF;--caution:#9A5B00}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 Archivo,system-ui,sans-serif}
main{max-width:34rem;margin:8vh auto;padding:0 16px}
.card{background:var(--surface);border:1px solid var(--seam);border-radius:12px;padding:24px}
h1{font-size:1.4rem;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:.9rem}
.warn{border-left:3px solid var(--caution);padding-left:10px}
button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid var(--seam);background:transparent;color:var(--text);cursor:pointer}
button.primary{background:var(--brand);border-color:var(--brand);color:var(--on-brand)}
.row{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
</style></head><body><main><div class="card">${body}</div>
<p class="muted" style="margin-top:16px">The Agent Forge · AI, tested on everyday jobs.</p></main></body></html>`;
  return new Response(html, { status, headers });
}

export const errorPage = (title: string, message: string, status = 400) =>
  page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`, new Headers(), status);
