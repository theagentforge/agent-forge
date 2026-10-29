import { env } from "cloudflare:workers";
import { TEASE_LINE, type Duel } from "@forge/arena";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyCard, CARD_PARTS, cardParts, PLAY, HOLD, runIdOf, TIMES, type CardElement } from "../public/gauntlet.js";
import { channelDuels } from "../src/arena/featured";
import { planEvent, processQueue } from "../src/arena/runner";
import { getDb } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";

// Site audit 29 Oct, issue 6: the Arena replay card once showed parts of two different bouts at once (one bout's
// label beside another bout's log, referee lines and costs). Every part of the card now carries the bout's run id
// (data-run) and is written in one step from cardParts().

const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
let base: Duel;

beforeAll(async () => {
  let n = 0;
  vi.spyOn(env.AI, "run").mockImplementation((async (model: string) => {
    n++;
    const finish = model.includes("gpt-oss") ? { status: "cannot_complete", summary: "Checking is short and savings is locked." } : { status: "done", summary: "Paid in full." };
    return { choices: [{ message: { content: null, tool_calls: [n % 2 ? call("get_accounts", {}) : call("finish", finish)] } }], usage: { prompt_tokens: 800, completion_tokens: 60 } };
  }) as never);
  await env.KV.delete("arena:lock");
  await planEvent(env, { slug: "replay-card-test", name: "Replay card test", season: "s0", kind: "practice", models: ["gpt-oss-120b", "qwen3-30b"], tasks: ["impossible"], seeds: [1, 2], attempts: 1 });
  await processQueue(env, Date.now() + 60_000);
  const duels = await channelDuels(env, getDb(env));
  base = duels.find((d) => d.gauntlet)!;
  expect(base).toBeTruthy();
});

/** Four different bouts: each its own run ids, job title, trap and model names, so a mixed card is easy to spot. */
function bouts(): Duel[] {
  return ["Alpha", "Bravo", "Charlie", "Delta"].map((tag, k) => {
    const d = structuredClone(base);
    d.title = `The ${tag} Job`;
    d.headline = `${tag} headline: one caught it, one fell.`;
    if (k % 2) delete d.stakes;
    else d.stakes = `${tag} stakes line.`;
    d.captions = [`The job: ${tag} brief.`];
    d.gauntlet!.tell = k === 2 ? null : `${tag} hidden trap`;
    d.gauntlet!.lanes.forEach((l, j) => {
      l.id = `${tag.toLowerCase()}${j}`.padEnd(32, String(k));
      l.model = `${tag}Model${j ? "B" : "A"}`;
      l.name = `${tag} ${j ? "B" : "A"}`;
      l.steps.forEach((s) => (s.line = s.line.replace(/\(/, `(${tag.toLowerCase()}: `)));
    });
    return d;
  });
}

/** A stand-in for the player's elements: just enough DOM for applyCard. */
function fakePlayer() {
  const mk = (): CardElement & { attrs: Record<string, string>; picks: { textContent: string; disabled: boolean; attrs: Record<string, string>; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void }[] } => {
    const attrs: Record<string, string> = {};
    const picks = ["a", "b"].map((side) => {
      const a: Record<string, string> = { "data-pick": side };
      return { textContent: "", disabled: true, attrs: a, getAttribute: (n: string) => a[n] ?? null, setAttribute: (n: string, v: string) => void (a[n] = v) };
    });
    return { textContent: "", innerHTML: "", hidden: false, attrs, picks, setAttribute: (n, v) => void (attrs[n] = v), getAttribute: (n) => attrs[n] ?? null, querySelectorAll: () => picks };
  };
  const els = Object.fromEntries(CARD_PARTS.map((s) => [s, mk()]));
  const rootAttrs: Record<string, string> = {};
  const root = { getAttribute: (n: string) => rootAttrs[n] ?? null, setAttribute: (n: string, v: string) => void (rootAttrs[n] = v) };
  return { els, root, q: (s: string) => els[s] ?? null };
}

/** Every visible part of the card, as text, for one element. */
const shown = (el: ReturnType<typeof fakePlayer>["els"][string]) => `${el.textContent} ${el.innerHTML} ${el.picks.map((p) => p.textContent).join(" ")}`;

describe("the replay card shows one bout at a time (audit issue 6)", () => {
  it("over 10 cycles, every part carries the same run id and only that bout's words", () => {
    const list = bouts();
    const tags = ["Alpha", "Bravo", "Charlie", "Delta"];
    const p = fakePlayer();
    const slot = PLAY + HOLD;
    let swaps = 0;
    // Ten full cycles through the channel. Frames are sampled across each bout; some frames are skipped, as when the
    // card is scrolled off screen, which is how the old card fell out of step.
    for (let cycle = 0; cycle < 10; cycle++) {
      for (let i = 0; i < list.length; i++) {
        const d = list[i]!;
        const times = [0, TIMES.T_RUN! + 0.1, TIMES.T_TRAP!, TIMES.T_VERDICT! + 0.1, slot - 0.01].filter((_, k) => (cycle + k) % 3 !== 1 || k === 0);
        for (const t of times) {
          if (applyCard(p.q, cardParts(d, t, { tease: TEASE_LINE, geo: cycle % 2 ? "compact" : "wide" }), p.root)) swaps++;
          const run = runIdOf(d);
          expect(p.root.getAttribute("data-run")).toBe(run);
          for (const sel of CARD_PARTS) {
            const el = p.els[sel]!;
            expect(el.getAttribute("data-run"), `${sel} in cycle ${cycle}, bout ${i}, t=${t}`).toBe(run);
            const text = shown(el);
            for (const other of tags.filter((x) => x !== tags[i])) expect(text, `${sel} shows ${other} while playing ${tags[i]}`).not.toContain(other);
          }
          // The label, the cost lines and the share text all name this bout.
          expect(p.els["[data-gx-label]"]!.textContent).toContain(d.title);
          expect(p.els["[data-gx-foot]"]!.innerHTML).toContain(d.gauntlet!.lanes[0].model);
          expect(p.els["[data-gx-foot]"]!.innerHTML).toContain(`data-run="${run}"`);
          expect(p.els["[data-gx-grid]"]!.textContent).toContain(run);
          expect(p.els["[data-gx-stakes]"]!.hidden).toBe(!d.stakes);
          expect(p.els["[data-gx-tell]"]!.hidden).toBe(!d.gauntlet!.tell);
          expect(p.els["[data-headline]"]!.textContent).toBe(t >= TIMES.T_VERDICT! ? d.headline : TEASE_LINE);
          if (t >= TIMES.T_VERDICT!) expect(p.els["[data-gx-term]"]!.innerHTML).toContain(`referee ▸ [A] ${d.gauntlet!.lanes[0].model}`);
        }
      }
    }
    expect(swaps).toBe(10 * list.length);
  });

  it("the server-drawn card on /arena: every part names the same run, and the Full bout link points at it", async () => {
    const body = await (await fetchWorker("/arena", { headers: { Accept: "text/html" } })).text();
    const fig = /<figure class="gx"[\s\S]*?<\/figure>/.exec(body)![0];
    const runs = [...fig.matchAll(/data-run="([^"]+)"/g)].map((m) => m[1]);
    // The figure, its label, headline, tell, job, trap, stage, terminal head and lines, cost lines (2 lanes and the
    // note), the predict row, stakes and share text.
    expect(runs.length).toBeGreaterThanOrEqual(CARD_PARTS.length + 1);
    expect(new Set(runs).size).toBe(1);
    for (const sel of CARD_PARTS) expect(fig, sel).toMatch(new RegExp(`${sel.slice(1, -1)}[^>]*data-run="${runs[0]}"`));
    expect(body).toMatch(new RegExp(`href="/arena/run/${runs[0]}" data-gx-full="gx" data-run="${runs[0]}"`));
  });
});
