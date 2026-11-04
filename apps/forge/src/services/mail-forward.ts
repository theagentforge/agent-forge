// Inbound business mail: one copy to each destination in MAIL_FORWARD_TO (ADR 0122, docs/ops/inbound-routing.md).
//
// Cloudflare Email Routing sends one rule to one address, so the five business addresses are routed to this Worker
// ("Send to a Worker"), and the `email` handler forwards each message once per destination.
// Runtime API (checked 30 Oct 2026, page last updated 15 Oct 2026):
//   https://developers.cloudflare.com/email-service/api/route-emails/email-handler/
//   ForwardableEmailMessage { from, to, headers, raw, rawSize, canBeForwarded, setReject(reason),
//   forward(rcptTo, headers?): Promise<EmailSendResult>, reply(message) }. forward() only reaches verified destination
//   addresses; an unverified one throws.
// Wrangler config: an email handler needs no binding; routing rules point at the Worker by name
//   (https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/). The optional top-level
//   `addresses` field would make every deploy (staging included) manage the rules, so it is not used: the rules are
//   switched by hand after the production release.

/** The only addresses this handler accepts; anything else is refused. */
export const BUSINESS_ALIASES = ["hello", "partners", "press", "disputes", "ops"] as const;
export const MAIL_DOMAIN = "theagentforge.io";

export const REJECT_UNKNOWN = "unknown address";
export const REJECT_TEMPORARY = "temporary delivery failure, please try again later";

/** The comma-separated destination list; empty (staging, or unset) means forward nothing. */
export function forwardDestinations(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@")))];
}

/** The alias (e.g. "hello") when `to` is one of the five business addresses, otherwise null. */
export function businessAlias(to: string): (typeof BUSINESS_ALIASES)[number] | null {
  const addr = to.trim().toLowerCase().replace(/^<|>$/g, "");
  const at = addr.lastIndexOf("@");
  if (at < 1 || addr.slice(at + 1) !== MAIL_DOMAIN) return null;
  const local = addr.slice(0, at);
  return (BUSINESS_ALIASES as readonly string[]).includes(local) ? (local as (typeof BUSINESS_ALIASES)[number]) : null;
}

/** What the handler needs from the message (a subset of ForwardableEmailMessage, so tests can pass a fake). */
export type InboundMail = Pick<ForwardableEmailMessage, "to" | "forward" | "setReject">;

export type ForwardOutcome =
  | { outcome: "rejected_unknown" }
  | { outcome: "not_configured"; alias: string }
  | { outcome: "forwarded" | "partial" | "all_failed"; alias: string; delivered: number; failed: number };

/**
 * Forwards to every destination independently (one failing, e.g. not yet verified, never stops the others).
 * Logs only the alias and the counts: never the sender, subject, body or the error text (which can echo addresses).
 */
export async function forwardBusinessMail(message: InboundMail, env: { MAIL_FORWARD_TO?: string }): Promise<ForwardOutcome> {
  const alias = businessAlias(message.to);
  if (!alias) {
    message.setReject(REJECT_UNKNOWN);
    console.log("mail_forward", JSON.stringify({ outcome: "rejected_unknown" }));
    return { outcome: "rejected_unknown" };
  }
  const destinations = forwardDestinations(env.MAIL_FORWARD_TO);
  if (destinations.length === 0) {
    console.log("mail_forward", JSON.stringify({ alias, outcome: "not_configured" }));
    return { outcome: "not_configured", alias };
  }
  const results = await Promise.allSettled(destinations.map((d) => message.forward(d)));
  const delivered = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - delivered;
  const outcome = failed === 0 ? "forwarded" : delivered === 0 ? "all_failed" : "partial";
  if (outcome === "all_failed") message.setReject(REJECT_TEMPORARY);
  const line = JSON.stringify({ alias, outcome, delivered, failed });
  if (outcome === "forwarded") console.log("mail_forward", line);
  else console.warn("mail_forward", line);
  return { outcome, alias, delivered, failed };
}
