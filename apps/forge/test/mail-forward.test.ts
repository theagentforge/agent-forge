import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  BUSINESS_ALIASES,
  businessAlias,
  forwardBusinessMail,
  forwardDestinations,
  REJECT_TEMPORARY,
  REJECT_UNKNOWN,
  type InboundMail,
} from "../src/services/mail-forward";

const DESTS = "owner-b@example.com,owner-a@example.org";
const SENDER = "buyer-person@example.com";
const SUBJECT = "Acquisition enquiry SECRET-SUBJECT";

/** A fake ForwardableEmailMessage: records forwards and rejects; `failFor` destinations throw like an unverified one. */
function fakeMessage(to: string, failFor: string[] = []) {
  const forwarded: string[] = [];
  const rejects: string[] = [];
  const msg = {
    from: SENDER,
    to,
    headers: new Headers({ subject: SUBJECT }),
    raw: new ReadableStream(),
    rawSize: 42,
    canBeForwarded: true,
    setReject: (reason: string) => void rejects.push(reason),
    forward: async (rcpt: string) => {
      if (failFor.includes(rcpt)) throw new Error(`destination address not verified: ${rcpt}`);
      forwarded.push(rcpt);
      return { messageId: "m" } as unknown as EmailSendResult;
    },
    reply: async () => ({}) as unknown as EmailSendResult,
  };
  return { msg, forwarded, rejects };
}

function captureLogs() {
  const lines: string[] = [];
  const grab = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
  vi.spyOn(console, "error").mockImplementation(grab);
  return lines;
}

afterEach(() => vi.restoreAllMocks());

describe("mail forwarding (ADR 0122)", () => {
  it("parses the destination list and the five aliases", () => {
    expect(forwardDestinations(DESTS)).toEqual(["owner-b@example.com", "owner-a@example.org"]);
    expect(forwardDestinations(" a@x.io , ,A@x.io")).toEqual(["a@x.io"]);
    expect(forwardDestinations(undefined)).toEqual([]);
    expect(forwardDestinations("")).toEqual([]);
    for (const a of BUSINESS_ALIASES) expect(businessAlias(`${a}@theagentforge.io`)).toBe(a);
    expect(businessAlias("Hello@TheAgentForge.io")).toBe("hello");
    expect(businessAlias("admin@theagentforge.io")).toBeNull();
    expect(businessAlias("hello@theagentforge.io.evil.com")).toBeNull();
    expect(businessAlias("hello@staging.theagentforge.io")).toBeNull();
  });

  it("forwards to both destinations", async () => {
    captureLogs();
    for (const alias of BUSINESS_ALIASES) {
      const { msg, forwarded, rejects } = fakeMessage(`${alias}@theagentforge.io`);
      const r = await forwardBusinessMail(msg, { MAIL_FORWARD_TO: DESTS });
      expect(forwarded.sort()).toEqual(["owner-a@example.org", "owner-b@example.com"]);
      expect(rejects).toEqual([]);
      expect(r).toEqual({ outcome: "forwarded", alias, delivered: 2, failed: 0 });
    }
  });

  it("one destination throwing still forwards to the other, and the mail is not refused", async () => {
    captureLogs();
    const { msg, forwarded, rejects } = fakeMessage("partners@theagentforge.io", ["owner-a@example.org"]);
    const r = await forwardBusinessMail(msg, { MAIL_FORWARD_TO: DESTS });
    expect(forwarded).toEqual(["owner-b@example.com"]);
    expect(rejects).toEqual([]);
    expect(r).toEqual({ outcome: "partial", alias: "partners", delivered: 1, failed: 1 });
  });

  it("every destination failing refuses the mail with a temporary-failure message", async () => {
    captureLogs();
    const { msg, forwarded, rejects } = fakeMessage("press@theagentforge.io", DESTS.split(","));
    const r = await forwardBusinessMail(msg, { MAIL_FORWARD_TO: DESTS });
    expect(forwarded).toEqual([]);
    expect(rejects).toEqual([REJECT_TEMPORARY]);
    expect(r.outcome).toBe("all_failed");
  });

  it("an unknown recipient is refused and nothing is forwarded", async () => {
    captureLogs();
    const { msg, forwarded, rejects } = fakeMessage("ceo@theagentforge.io");
    const r = await forwardBusinessMail(msg, { MAIL_FORWARD_TO: DESTS });
    expect(forwarded).toEqual([]);
    expect(rejects).toEqual([REJECT_UNKNOWN]);
    expect(r.outcome).toBe("rejected_unknown");
  });

  it("with no MAIL_FORWARD_TO (staging), nothing is forwarded", async () => {
    captureLogs();
    const { msg, forwarded, rejects } = fakeMessage("ops@theagentforge.io");
    expect(await forwardBusinessMail(msg, {})).toEqual({ outcome: "not_configured", alias: "ops" });
    expect(await forwardBusinessMail(msg, { MAIL_FORWARD_TO: "" })).toEqual({ outcome: "not_configured", alias: "ops" });
    expect(forwarded).toEqual([]);
    expect(rejects).toEqual([]);
  });

  it("logs only the alias and the outcome: never the sender, subject, body or destination", async () => {
    const lines = captureLogs();
    for (const [to, fail] of [
      ["hello@theagentforge.io", []],
      ["hello@theagentforge.io", ["owner-a@example.org"]],
      ["hello@theagentforge.io", DESTS.split(",")],
      ["nobody@theagentforge.io", []],
    ] as const) {
      await forwardBusinessMail(fakeMessage(to, [...fail]).msg, { MAIL_FORWARD_TO: DESTS });
    }
    expect(lines.length).toBe(4);
    const all = lines.join("\n");
    for (const leak of [SENDER, SUBJECT, "SECRET", "owner-b", "owner-a", "not verified", "nobody"]) expect(all).not.toContain(leak);
    for (const l of lines) expect(l).toMatch(/^mail_forward \{/);
  });

  it("the Worker's default export has an email handler, alongside fetch and scheduled", async () => {
    captureLogs();
    expect(typeof worker.email).toBe("function");
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
    const { msg, forwarded } = fakeMessage("disputes@theagentforge.io");
    await worker.email!(msg as unknown as ForwardableEmailMessage, { MAIL_FORWARD_TO: DESTS } as Env);
    expect(forwarded.length).toBe(2);
  });
});

// Keeps the fake honest: it must satisfy the subset the handler uses.
const _typecheck: InboundMail = fakeMessage("x@y").msg;
void _typecheck;
