import { html } from "hono/html";
import { send, sendJson, site, wantsJson } from "./pages";

// /security/thanks: people who reported a security issue to us responsibly and asked to be named (Dinike
// approved, 24 Nov). security.txt's Acknowledgments field (RFC 9116 §2.5.1) and SECURITY.md in the public repo link here;
// no menu, footer or home link, so it never competes with the product pages. Details are kept to one line each, as
// RFC 9116 advises, so an entry never helps an attack.

export const SECURITY_THANKS_PATH = "/security/thanks";

export interface Acknowledgement {
  date: string;
  name: string;
  url: string;
  summary: string;
}

export const ACKNOWLEDGEMENTS: readonly Acknowledgement[] = [
  {
    date: "2026-11-24",
    name: "Suryanarayan Renjith",
    url: "https://surya.is-a.dev/",
    summary: "Outside text could be shown back inside tool answers and receipts. Fixed and released the same week.",
  },
];

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

site.get(SECURITY_THANKS_PATH, async (c) => {
  if (wantsJson(c)) return sendJson(c, { acknowledgements: ACKNOWLEDGEMENTS, report_to: "mailto:hello@theagentforge.io" });
  return send(c, {
    title: "Security thanks",
    description: "People who reported security issues to The Agent Forge responsibly.",
    path: SECURITY_THANKS_PATH,
    jsonAlternate: `${SECURITY_THANKS_PATH}?format=json`,
    body: html`<div class="prose">
<h1 class="page-title">Security thanks</h1>
<p class="lead">We thank these people for reporting security issues to us responsibly.</p>
<ul>
${ACKNOWLEDGEMENTS.map((a) => html`<li>${fmt(a.date)}: <a href="${a.url}" rel="noopener">${a.name}</a>. ${a.summary}</li>`)}
</ul>
<p class="small muted">Found something? Email <a href="mailto:hello@theagentforge.io">hello@theagentforge.io</a> with "Security" in the subject. Our policy is in <a href="https://github.com/theagentforge/agent-forge/blob/main/SECURITY.md">SECURITY.md</a>.</p>
</div>`,
  });
});
