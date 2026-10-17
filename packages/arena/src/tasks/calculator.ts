import type { ToolDef } from "../types";
import { fail, ok } from "./util";

// Hard v3 (ADR 0021 amendment 4): every Hard v3 job has a calculator, so the referee's exact-cent rules test judgement
// (which formula, which items), never mental arithmetic. A small safe parser: numbers, + - * / %, parentheses, and
// round(x, places), min, max, abs. No variables, no eval.

const MAX_EXPRESSIONS = 20;
const MAX_LENGTH = 200;

type Tok = { k: "num"; v: number } | { k: "op"; v: string } | { k: "id"; v: string };

function lex(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) i++;
    else if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?|^[0-9]+\.?/i.exec(s.slice(i))!;
      out.push({ k: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (/[a-z]/i.test(c)) {
      const m = /^[a-z]+/i.exec(s.slice(i))!;
      out.push({ k: "id", v: m[0].toLowerCase() });
      i += m[0].length;
    } else if ("+-*/%(),".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
    } else if (c === "$") i++; // "$12.50" reads as 12.50
    else throw new Error(`Unexpected "${c}".`);
  }
  return out;
}

const FNS: Record<string, (a: number[]) => number> = {
  round: ([x, p = 0]) => {
    if (x === undefined) throw new Error("round needs a number.");
    const f = 10 ** Math.max(0, Math.min(6, Math.trunc(p)));
    return Math.round((x + Math.sign(x) * Number.EPSILON) * f) / f;
  },
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  abs: ([x]) => Math.abs(x ?? NaN),
};

/** Evaluates one arithmetic expression. Throws a plain-English error for anything else. */
export function evaluate(expr: string): number {
  if (expr.length > MAX_LENGTH) throw new Error(`Expressions are limited to ${MAX_LENGTH} characters.`);
  const t = lex(expr);
  let p = 0;
  const peek = () => t[p];
  const take = (v?: string) => {
    const x = t[p];
    if (!x || (v !== undefined && x.v !== v)) throw new Error(v ? `Expected "${v}".` : "Unexpected end.");
    p++;
    return x;
  };
  const sum = (): number => {
    let v = product();
    while (peek()?.k === "op" && (peek()!.v === "+" || peek()!.v === "-")) v = take().v === "+" ? v + product() : v - product();
    return v;
  };
  const product = (): number => {
    let v = unary();
    while (peek()?.k === "op" && ["*", "/", "%"].includes(peek()!.v as string)) {
      const op = take().v;
      const r = unary();
      if ((op === "/" || op === "%") && r === 0) throw new Error("Division by zero.");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const unary = (): number => (peek()?.k === "op" && peek()!.v === "-" ? (take(), -unary()) : peek()?.k === "op" && peek()!.v === "+" ? (take(), unary()) : atom());
  const atom = (): number => {
    const x = take();
    if (x.k === "num") return x.v;
    if (x.k === "op" && x.v === "(") {
      const v = sum();
      take(")");
      return v;
    }
    if (x.k === "id" && FNS[x.v]) {
      take("(");
      const args = [sum()];
      while (peek()?.v === ",") (take(","), args.push(sum()));
      take(")");
      return FNS[x.v]!(args);
    }
    throw new Error(x.k === "id" ? `Unknown name "${x.v}". Use numbers, + - * / %, parentheses, round, min, max, abs.` : `Unexpected "${x.v}".`);
  };
  const v = sum();
  if (p !== t.length) throw new Error(`Unexpected "${String(t[p]!.v)}".`);
  if (!Number.isFinite(v)) throw new Error("The result isn't a finite number.");
  return v;
}

/** The calculator tool every Hard v3 job adds. Read-only, so it never changes the world. */
export function calculatorTool<S>(): ToolDef<S> {
  return {
    name: "calculate",
    description: `Evaluates up to ${MAX_EXPRESSIONS} arithmetic expressions at once (numbers, + - * / %, parentheses, round(x, places), min, max, abs), e.g. ["round(222.10 * 72.35 / 277.65, 2)"]. Returns each result.`,
    parameters: {
      type: "object",
      properties: { expressions: { type: "array", items: { type: "string" }, description: `1 to ${MAX_EXPRESSIONS} expressions` } },
      required: ["expressions"],
      additionalProperties: false,
    },
    readOnly: true,
    run: (args) => {
      const xs = args.expressions;
      if (!Array.isArray(xs) || !xs.length || xs.length > MAX_EXPRESSIONS || !xs.every((x) => typeof x === "string")) return fail(`"expressions" must be 1 to ${MAX_EXPRESSIONS} strings.`);
      return ok(
        (xs as string[]).map((expression) => {
          try {
            return { expression, result: Math.round(evaluate(expression) * 1e9) / 1e9 };
          } catch (e) {
            return { expression, error: (e as Error).message };
          }
        }),
      );
    },
  };
}
