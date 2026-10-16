import type { ToolSpec } from "@forge/arena";
import type { ToolCall } from "./adapters";

// Llama models write tool calls as text in their own "pythonic" format, e.g. `[search_flights(from=Kestrel Bay,
// date=2026-10-30), delete_row(5)]`, and Workers AI doesn't turn that into structured tool calls. Dry run 1 scored
// Llama 4 Scout 0/12 because of it. This reads that format into the same tool calls every other model sends; it is
// a transport fix (like a provider's own parser), switched on per route, and never changes what the model said.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }
  peek() {
    return this.s[this.i];
  }
  eat(ch: string) {
    this.ws();
    if (this.s[this.i] === ch) {
      this.i++;
      return true;
    }
    return false;
  }
  ident() {
    this.ws();
    const m = IDENT.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }
  /** A value: quoted string, number, literal, list/dict, or bare text up to the next top-level `,` or `)`. */
  value(): unknown {
    this.ws();
    const c = this.peek();
    if (c === '"' || c === "'") {
      let out = "";
      this.i++;
      while (this.i < this.s.length && this.s[this.i] !== c) {
        if (this.s[this.i] === "\\" && this.i + 1 < this.s.length) this.i++;
        out += this.s[this.i++];
      }
      this.i++;
      return out;
    }
    if (c === "[" || c === "{") {
      const start = this.i;
      let depth = 0;
      let q: string | null = null;
      for (; this.i < this.s.length; this.i++) {
        const ch = this.s[this.i]!;
        if (q) {
          if (ch === q) q = null;
        } else if (ch === '"' || ch === "'") q = ch;
        else if (ch === "[" || ch === "{") depth++;
        else if (ch === "]" || ch === "}") {
          depth--;
          if (depth === 0) {
            this.i++;
            break;
          }
        }
      }
      const raw = this.s.slice(start, this.i);
      try {
        return JSON.parse(raw.replace(/'/g, '"').replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null"));
      } catch {
        return raw;
      }
    }
    const start = this.i;
    let depth = 0;
    while (this.i < this.s.length) {
      const ch = this.s[this.i]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
      this.i++;
    }
    const raw = this.s.slice(start, this.i).trim();
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (raw === "True" || raw === "true") return true;
    if (raw === "False" || raw === "false") return false;
    if (raw === "None" || raw === "null") return null;
    return raw;
  }
}

/** Tool calls written as text at the start of a reply, or [] if the reply doesn't start with one. */
export function parsePythonicCalls(text: string | null, tools: ToolSpec[]): ToolCall[] {
  if (!text) return [];
  const r = new Reader(text.trim().replace(/^<\|python_start\|>/, ""));
  const bracketed = r.eat("[");
  const calls: ToolCall[] = [];
  while (true) {
    const save = r.i;
    const name = r.ident();
    if (!name || !r.eat("(")) {
      r.i = save;
      break;
    }
    const spec = tools.find((t) => t.name === name);
    const order = Object.keys((spec?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
    const args: Record<string, unknown> = {};
    let pos = 0;
    let ok = true;
    if (!r.eat(")")) {
      while (true) {
        r.ws();
        const before = r.i;
        const key = r.ident();
        if (key && r.eat("=")) args[key] = r.value();
        else {
          r.i = before;
          const v = r.value();
          const k = order[pos++];
          if (k === undefined) {
            ok = false;
            break;
          }
          args[k] = v;
        }
        if (r.eat(",")) continue;
        if (r.eat(")")) break;
        ok = false;
        break;
      }
    }
    if (!ok) break;
    calls.push({ id: `call_${calls.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
    if (!r.eat(",")) break;
  }
  if (bracketed && calls.length && !r.eat("]")) return calls; // a missing "]" is tolerated
  return calls;
}
