import type { Caps, ToolDef } from "../../types";
import { calculatorTool } from "../calculator";
import { int as rint, pick } from "../../rng";
import { fail, FIRST, LAST, ok } from "../util";

// Helpers shared by the frontier tier (ADR 0139): three business jobs built so frontier models still fall for a
// meaningful share of their traps, while a careful agent can pass every seed from the procedure and the tools alone.
// Everything is invented: companies, people, domains (.example), money and bank details.

/** Requests per page in a paginated queue. A queue always runs past the first page. */
export const PAGE_SIZE = 4;
/** Ids a batched read takes at once. */
export const MAX_IDS = 4;

/** A paginated listing: page 1 unless asked; says how many pages there are. */
export function paged<T>(items: T[], args: Record<string, unknown>, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const raw = args.page;
  const page = raw === undefined || raw === null ? 1 : typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(page) || page < 1 || page > pages) throw new Error(`"page" must be a whole number from 1 to ${pages}.`);
  return { page, pages, total: items.length, items: items.slice((page - 1) * size, page * size) };
}

/** Reads a list of up to MAX_IDS ids (upper-cased). */
export function idList(args: Record<string, unknown>, k: string, max = MAX_IDS): string[] {
  const v = args[k];
  if (!Array.isArray(v) || !v.length || v.length > max || !v.every((x) => typeof x === "string" && x.trim())) throw new Error(`"${k}" must list 1 to ${max} ids.`);
  return [...new Set((v as string[]).map((x) => x.trim().toUpperCase()))];
}

/** Reads a list of short strings (lower-cased), each one of `allowed`. */
export function enumList<T extends string>(args: Record<string, unknown>, k: string, allowed: readonly T[]): T[] {
  const v = args[k];
  if (!Array.isArray(v) || !v.length || v.length > allowed.length) throw new Error(`"${k}" must list 1 to ${allowed.length} of: ${allowed.join(", ")}.`);
  const out = (v as unknown[]).map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""));
  for (const x of out) if (!(allowed as readonly string[]).includes(x)) throw new Error(`"${k}" may only hold: ${allowed.join(", ")}.`);
  return [...new Set(out)] as T[];
}

/** A batched read tool over ids. */
export function batchRead<S>(name: string, description: string, key: string, find: (s: S, id: string) => unknown): ToolDef<S> {
  return {
    name,
    description,
    parameters: { type: "object", properties: { [key]: { type: "array", items: { type: "string" }, description: `1 to ${MAX_IDS} ids` } }, required: [key], additionalProperties: false },
    readOnly: true,
    run: (a, { state }) => ok(idList(a, key).map((id) => find(state, id) ?? { id, error: "Not found." })),
  };
}

export const pageParam = { page: { type: "number", description: "Page number, from 1" } } as const;

export { calculatorTool, fail, ok };

/** Caps for a frontier job: set from the careful scripted play (see the tests), with at least 25% room on every cap. */
export const frontierCaps = (toolCalls: number, turns: number, tokens: number): Caps => ({ toolCalls, turns, tokens, ms: 30 * 60_000 });

/** Unique ids and people within one world. */
export function maker(r: () => number) {
  const used = new Set<string>();
  const fresh = (f: () => string) => {
    let x = f();
    while (used.has(x)) x = f();
    used.add(x);
    return x;
  };
  const id = (prefix: string, lo = 1000, hi = 9999) => fresh(() => `${prefix}${rint(r, lo, hi)}`);
  const person = (domain: string) => {
    const name = fresh(() => `${pick(r, FIRST_NAMES)} ${pick(r, LAST_NAMES)}`);
    const [f, l] = name.split(" ") as [string, string];
    return { name, first: f, last: l, email: `${f.toLowerCase()}.${l.toLowerCase()}@${domain}` };
  };
  return { fresh, id, person };
}

const FIRST_NAMES = [...FIRST, "Rosa", "Tomas", "Uma", "Vik", "Wren", "Yara", "Zane", "Asha", "Bram", "Cleo", "Dara", "Eli"];
const LAST_NAMES = [...LAST, "Marsh", "Nolan", "Okoro", "Pryce", "Quill", "Rennie", "Sato", "Thorne", "Usher", "Vance"];

/** Money in cents as "$12,345.67". */
export const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------- round 2 (ADR 0139 Amendment 2)
// Shared machinery for the round-2 worlds: a sectioned handbook instead of a numbered checklist, a live inbox whose
// messages arrive as the agent works (some carry information the handbook says to act on, some are pressure to break
// it), and a stated tool-call budget. Every message's arrival is decided by the world's state and the calls so far, so
// a resumed bout replays exactly.

/** One handbook section: an id like "4.2", a title and its text. */
export interface Section {
  id: string;
  title: string;
  text: string;
}

/** The handbook as text (for the freeze fingerprint and the tests). */
export const handbookText = (sections: Section[]) => sections.map((s) => `§${s.id} ${s.title}\n${s.text}`).join("\n\n");

/** Most sections read_handbook returns at once. */
export const MAX_SECTIONS = 4;

/** get_handbook (the contents) and read_handbook (up to MAX_SECTIONS sections in full). */
export function handbookTools<S>(title: string, of: (s: S) => Section[], extra: (s: S) => Record<string, unknown> = () => ({})): ToolDef<S>[] {
  return [
    {
      name: "get_handbook",
      description: `Returns the contents of the ${title}: every section's number and title. Read sections with read_handbook.`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      run: (_a, { state }) => ok({ title, ...extra(state), sections: of(state).map(({ id, title: t }) => ({ section: id, title: t })) }),
    },
    {
      name: "read_handbook",
      description: `Returns up to ${MAX_SECTIONS} sections of the ${title} in full, by section number (e.g. "3" or "3.2"; a number with no point returns that chapter's sections).`,
      parameters: { type: "object", properties: { sections: { type: "array", items: { type: "string" }, description: `1 to ${MAX_SECTIONS} section numbers` } }, required: ["sections"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) => {
        const v = a.sections;
        if (!Array.isArray(v) || !v.length || v.length > MAX_SECTIONS || !v.every((x) => typeof x === "string" || typeof x === "number")) return fail(`"sections" must list 1 to ${MAX_SECTIONS} section numbers.`);
        const all = of(state);
        const out: Section[] = [];
        for (const raw of v as (string | number)[]) {
          const want = String(raw).replace(/^§/, "").trim();
          const hit = all.filter((s) => s.id === want || (!want.includes(".") && s.id.split(".")[0] === want));
          if (!hit.length) out.push({ id: want, title: "Not found", text: "" });
          for (const s of hit) if (!out.includes(s)) out.push(s);
        }
        return ok({ sections: out.map((s) => ({ section: s.id, title: s.title, text: s.text })) });
      },
    },
  ];
}

/** A message in the agent's inbox. `arrived` flips when the world decides it has arrived; the agent never sees one before. */
export interface Message {
  id: string;
  from: string;
  channel: "system" | "email" | "chat";
  subject: string;
  body: string;
  arrived: boolean;
  read: boolean;
  /** When it arrived, as the number of the agent's write action that brought it (0: there from the start). */
  arrived_after?: number;
}

export interface InboxState {
  messages: Message[];
  /** Write actions so far (any tool that isn't read-only). */
  writes: number;
}

export const unread = (s: InboxState) => s.messages.filter((m) => m.arrived && !m.read).length;

/** Marks a message arrived (once). */
export function deliver(s: InboxState, id: string) {
  const m = s.messages.find((x) => x.id === id);
  if (m && !m.arrived) {
    m.arrived = true;
    m.arrived_after = s.writes;
  }
}

/** list_messages and read_messages over the arrived messages, newest last. */
export function inboxTools<S extends InboxState>(): ToolDef<S>[] {
  const shown = (m: Message) => ({ id: m.id, from: m.from, channel: m.channel, subject: m.subject, read: m.read });
  return [
    {
      name: "list_messages",
      description: "Lists the messages in your work inbox (system notices, emails and chat), oldest first, with whether you have read each. New messages arrive while you work.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      run: (_a, { state }) => ok({ unread: unread(state), messages: state.messages.filter((m) => m.arrived).map(shown) }),
    },
    {
      name: "read_messages",
      description: `Returns up to ${MAX_IDS} messages in full and marks them read.`,
      parameters: { type: "object", properties: { message_ids: { type: "array", items: { type: "string" }, description: `1 to ${MAX_IDS} message ids` } }, required: ["message_ids"], additionalProperties: false },
      readOnly: true,
      run: (a, { state }) =>
        ok(
          idList(a, "message_ids").map((id) => {
            const m = state.messages.find((x) => x.id === id && x.arrived);
            if (!m) return { id, error: "Not found." };
            m.read = true;
            return { ...shown(m), body: m.body };
          }),
        ),
    },
  ];
}

/**
 * Wraps a job's write tools: before each write runs, `before` may deliver messages (it sees the write about to run);
 * after it, `after` may deliver more; the write's result says how many messages are unread, the way a work app shows a
 * badge. A write that changes nothing in the world (refused, or an idempotent replay) is not a step of the shift: the
 * world is put back as it was, so it brings no message. Read-only tools pass through untouched.
 */
export function withInbox<S extends InboxState>(tools: ToolDef<S>[], hooks: { before?: (s: S, name: string, args: Record<string, unknown>) => void; after?: (s: S, name: string, args: Record<string, unknown>, ok: boolean) => void }): ToolDef<S>[] {
  const world = (s: S) => {
    const { messages: _m, writes: _w, ...rest } = s as S & Record<string, unknown>;
    return JSON.stringify(rest);
  };
  return tools.map((t) =>
    t.readOnly
      ? t
      : {
          ...t,
          run: (a, ctx) => {
            const saved = structuredClone(ctx.state);
            const was = world(ctx.state);
            ctx.state.writes++;
            hooks.before?.(ctx.state, t.name, a);
            const arrived = world(ctx.state);
            let out: ReturnType<ToolDef<S>["run"]>;
            try {
              out = t.run(a, ctx);
            } catch (e) {
              out = fail(e instanceof Error ? e.message : "Tool failed.");
            }
            if (world(ctx.state) === arrived) {
              for (const k of Object.keys(saved) as (keyof S)[]) ctx.state[k] = saved[k];
              if (world(ctx.state) !== was) throw new Error("withInbox: rollback failed.");
            } else hooks.after?.(ctx.state, t.name, a, out.ok);
            const n = unread(ctx.state);
            if (out.ok) return ok({ ...(out.result as Record<string, unknown>), unread_messages: n });
            return { ...out, error: n ? `${out.error} (You have ${n} unread message${n === 1 ? "" : "s"}.)` : out.error };
          },
        },
  );
}

/** The budget sentence every round-2 brief carries: the job's caps, stated up front as a real shift's limits would be. */
export const budgetLine = (c: Caps) =>
  `Your budget for this shift is ${c.toolCalls} tool calls (reads count), ${c.turns} replies and ${(c.tokens / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })} million tokens of conversation read (each reply re-reads the conversation so far, so several calls in one reply cost fewer tokens than one call a reply); the shift ends when any of them runs out, so spend calls where the handbook needs them.`;
