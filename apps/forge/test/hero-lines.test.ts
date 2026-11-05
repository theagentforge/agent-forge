import { env } from "cloudflare:workers";
import { anyTaskById, Attempt, PRACTICE_ONLY_TASK_IDS, TRAP_CATALOG, type AttemptResult } from "@forge/arena";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  FIXED_LINE,
  HERO_LINES,
  HERO_STATE_KEY,
  heroClickCounters,
  heroLineStats,
  heroProofs,
  homeHero,
  homeHeroJson,
  latestFall,
  lineAction,
  linePairs,
  lineText,
  randomIndex,
  RECHECK_MS,
  STRIP_ORDER,
} from "../src/arena/hero-proof";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { heroLinesPanel } from "../src/web/admin-kpis";
import { HOME_OG_TITLE } from "../src/web/pages";
import { buttonState, cycleOrder, initial, running, sameFrame, update, STEP_MS, FADE_MS, type HeroRotState } from "../public/hero-lines.js";
import heroScript from "../public/hero-lines.js?raw";
import { fetchWorker } from "./helpers";
import "../src/index";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";

// ADR 0130: one true headline per visit, then one cycle through the other backed lines (Dinike, 5 Nov 10:30 and 10:39).

const MODEL_WORDS = "Everything is done, all good";
const BROWSER = { "user-agent": "Mozilla/5.0", "sec-fetch-mode": "navigate", accept: "text/html" };
let n = 0;
const page = async () => (await fetchWorker(`/?n=lines${++n}`, { headers: { Accept: "text/html" } })).text();
const reset = () => env.KV.delete(HERO_STATE_KEY);
const ev = { practice: crypto.randomUUID(), ranked: crypto.randomUUID(), held: crypto.randomUUID() };
const ids: Record<string, string> = {};
const t0 = Date.UTC(2026, 9, 20);

function made(task: string, fell: string[], status: "done" | "cannot_complete" = "done") {
  const a = new Attempt(anyTaskById(task)!, 5_200_001);
  a.recordTurn({ tokensIn: 500, tokensOut: 40, cost: 0.001, latencyMs: 700, text: MODEL_WORDS });
  a.call("finish", { status, summary: MODEL_WORDS });
  const base = a.end("finished");
  const traps = base.traps.map((x) => ({ ...x, triggered: fell.includes(x.id) }));
  for (const f of fell) if (!traps.some((x) => x.id === f)) traps.push({ id: f, label: f, triggered: true } as (typeof traps)[number]);
  return { result: { ...base, passed: false, traps } as AttemptResult, log: a.log };
}

async function add(key: string, o: { task: string; fell: string[]; status?: "done" | "cannot_complete"; event?: string; model?: string; at: number; heldOut?: boolean; badSig?: boolean }) {
  const r = made(o.task, o.fell, o.status);
  const id = crypto.randomUUID();
  const signature = o.badSig ? "nope" : await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(r.log) });
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId: o.event ?? ev.practice, modelId: o.model ?? "mistral-large-4", task: o.task, seed: 5_200_001, attemptNo: 1, status: "done", heldOut: o.heldOut ?? false,
    passed: false, score: 0.1, cost: 0.01, tokens: 900, result: r.result, log: r.log, signature, finishedAt: o.at,
  });
  ids[key] = id;
  return id;
}

beforeAll(async () => {
  await getDb(env).insert(t.arenaEvents).values([
    { id: ev.practice, slug: "lines-practice", name: "Lines practice", season: "s0", kind: "practice", status: "done" },
    { id: ev.ranked, slug: "lines-ranked", name: "Lines ranked", season: "s0", kind: "card", status: "done" },
    { id: ev.held, slug: "lines-held", name: "Lines held", season: "s0", kind: "card", status: "planned" },
  ]);
});

describe("the lines (wording for Dinike's OK)", () => {
  it("are exactly these six, short, past tense, with the highlight where it is today", () => {
    expect(HERO_LINES.map(lineText)).toEqual([
      "An AI agent paid a fake invoice and reported the job done.",
      "An AI agent ordered the same item twice and reported the job done.",
      "An AI agent sent money to a bank account that wasn't on file and reported the job done.",
      "An AI agent deleted a real record it mistook for a duplicate and reported the job done.",
      "An AI agent said the money was sent. It never was.",
      "An AI agent booked a hotel that broke the cancellation rules and reported the job done.",
    ]);
    expect(HERO_LINES.map((l) => l.strip)).toEqual(["fake invoices", "double orders", "money to bank accounts not on file", "real records deleted", "false “money sent” claims", "hotel cancellation rule breaks"]);
    expect(FIXED_LINE.key).toBe("invoice");
    for (const l of HERO_LINES) {
      expect(l.key.length, l.key).toBeLessThanOrEqual(12);
      expect(lineText(l).split(" ").length, l.key).toBeLessThanOrEqual(18);
      expect(lineText(l)).not.toMatch(/\b(shocking|incredible|scary|dangerous|safe|malicious|certif)/i);
    }
    // Only the action phrase rotates where the frame allows; the false-claim line swaps whole.
    expect(HERO_LINES.map(lineAction)).toEqual(["paid a fake invoice", "ordered the same item twice", "sent money to a bank account that wasn't on file", "deleted a real record it mistook for a duplicate", null, "booked a hotel that broke the cancellation rules"]);
    expect(new Set(STRIP_ORDER)).toEqual(new Set(HERO_LINES.map((l) => l.key)));
    // The approved strip, in its order (Dinike, 5 Nov).
    expect(`Caught in refereed runs: ${STRIP_ORDER.map((k) => HERO_LINES.find((l) => l.key === k)!.strip).join(" · ")}`).toBe(
      "Caught in refereed runs: fake invoices · double orders · money to bank accounts not on file · false “money sent” claims · real records deleted · hotel cancellation rule breaks",
    );
  });

  it("each line covers only public catalogue traps (never FA-*-101+ or a private family), on every public tier", () => {
    const pairs = Object.fromEntries(HERO_LINES.map((l) => [l.key, linePairs(l).map((p) => p.join("/")).sort()]));
    // Review 5 Nov: a tier whose referee records more than the words say is left out (see HERO_LINES).
    // Hard v3.3 (ADR 0132) shares the Hard v3 referee for these traps, so it is left out the same way.
    expect(pairs["invoice"]).toEqual(["scam-invoice/paid_scam"]); // Hard: a genuine invoice paid to a hijacked account also counts
    expect(pairs["bank-details"]).toEqual(["scam-invoice/wrong_account"]); // Hard: a superseded account listed in the master also counts
    expect(pairs["deleted-row"]).toEqual(["spreadsheet/deleted_real"]); // Hard: any row that had to stay, lookalike or not
    expect(pairs["double-order"]).toEqual(expect.arrayContaining(["flaky-supplier/double_order", "flaky-supplier-hard/double_order", "flaky-supplier-hard3/double_order"]));
    expect(pairs["false-claim"]).toEqual(["impossible-hard/false_claim", "impossible-hard3/false_claim", "impossible/false_claim"]);
    expect(pairs["hotel"]).toEqual(["weekend-hard/nonrefundable_hotel", "weekend-hard3/nonrefundable_hotel"]);
    for (const l of HERO_LINES) {
      for (const id of l.catalogue) {
        expect(TRAP_CATALOG.some((e) => e.id === id), id).toBe(true);
        expect(Number(id.split("-")[2]), id).toBeLessThan(101);
      }
      for (const [job] of linePairs(l)) expect(PRACTICE_ONLY_TASK_IDS).not.toContain(job);
    }
  });
});

describe("eligibility (ADR 0130 rules)", () => {
  it("no backed line: the fake-invoice question, no lines, no script, no strip", async () => {
    const h = await homeHero(env);
    expect(h.case).toBe("question");
    const body = await page();
    expect(body).not.toContain("data-hero-rot");
    expect(body).not.toContain("/hero-lines.js");
    expect(body).not.toContain("data-hero-strip");
    expect(homeHeroJson(h, env.PUBLIC_ORIGIN)).toMatchObject({ case: "question", lines: [] });
  });

  it("each line needs the referee's mark AND (except false-claim) the model's 'done'; exclusions never qualify", async () => {
    // Not called done: no line, even though the trap was sprung.
    await add("dup-cannot", { task: "flaky-supplier", fell: ["double_order"], status: "cannot_complete", at: t0 + 1 });
    // Public-rule exclusions, each with a qualifying fall otherwise.
    await add("dup-embargoed", { task: "flaky-supplier", fell: ["double_order"], model: EMBARGOED.id, at: t0 + 2 });
    await add("dup-heldout", { task: "flaky-supplier", fell: ["double_order"], heldOut: true, at: t0 + 3 });
    await add("dup-held-event", { task: "flaky-supplier", fell: ["double_order"], event: ev.held, at: t0 + 4 });
    await add("dup-badsig", { task: "flaky-supplier", fell: ["double_order"], badSig: true, at: t0 + 5 });
    // A private family's run (ADR 0057) is never a source, whatever it sprang.
    const priv = PRACTICE_ONLY_TASK_IDS[0];
    if (priv) await add("private", { task: priv, fell: ["double_order", "paid_scam"], at: t0 + 6 });
    // The Normal banking job: a "paid" message after part of the money moved is not "It never was".
    await add("claim-partial", { task: "impossible", fell: ["false_claim", "partial"], status: "cannot_complete", at: t0 + 7 });
    // The wrong trap for the job: deleted_real_row is the Hard spreadsheet's trap, not the Normal one's.
    await add("row-wrong-job", { task: "spreadsheet", fell: ["deleted_real_row"], at: t0 + 8 });
    // Review 5 Nov: Hard tiers whose referee records more than the words say never back those lines.
    await add("invoice-hard", { task: "scam-invoice-hard", fell: ["paid_scam"], at: t0 + 8.1 }); // may be a genuine invoice paid to a hijacked account
    await add("bank-hard", { task: "scam-invoice-hard3", fell: ["wrong_account"], at: t0 + 8.2 }); // may be a superseded account in the master
    await add("row-hard", { task: "spreadsheet-hard", fell: ["deleted_real_row"], at: t0 + 8.3 }); // may be a row that looked like no duplicate
    await reset();
    expect(await heroProofs(env)).toEqual([]);
    expect((await homeHero(env)).case).not.toBe("replay");
  });

  it("finds every line's qualifying public replay; false-claim needs no 'done'", async () => {
    await add("invoice", { task: "scam-invoice", fell: ["paid_scam"], at: t0 + 10 });
    await add("dup", { task: "flaky-supplier-hard", fell: ["double_order"], at: t0 + 11 });
    await add("bank", { task: "scam-invoice", fell: ["wrong_account"], at: t0 + 12 });
    await add("row", { task: "spreadsheet", fell: ["deleted_real"], at: t0 + 13 });
    await add("claim", { task: "impossible", fell: ["false_claim"], status: "cannot_complete", at: t0 + 14 });
    await add("hotel", { task: "weekend-hard", fell: ["nonrefundable_hotel"], at: t0 + 15 });
    await reset();
    const ps = await heroProofs(env);
    expect(ps.map((p) => [p.line, p.run])).toEqual([
      ["invoice", ids.invoice],
      ["double-order", ids.dup],
      ["bank-details", ids.bank],
      ["deleted-row", ids.row],
      ["false-claim", ids.claim],
      ["hotel", ids.hotel],
    ]);
    expect(ps.find((p) => p.line === "false-claim")!.claim).toBe("cannot_complete");
    expect(ps.find((p) => p.line === "deleted-row")!.trap.id).toBe("FA-DAT-001");
    expect(ps.find((p) => p.line === "hotel")!.trap.id).toBe("FA-POL-012");
    const excluded = ["dup-cannot", "dup-embargoed", "dup-heldout", "dup-held-event", "dup-badsig", "private", "claim-partial", "row-wrong-job", "invoice-hard", "bank-hard", "row-hard"].map((k) => ids[k]);
    for (const p of ps) expect(excluded).not.toContain(p.run);
  });

  it("keeps each pick; a ranked replay replaces a practice one (at the next recheck), never the other way", async () => {
    const before = await heroProofs(env);
    await add("dup-ranked", { task: "flaky-supplier", fell: ["double_order"], event: ev.ranked, at: t0 + 50 });
    // Within the recheck interval nothing moves.
    expect((await heroProofs(env)).find((p) => p.line === "double-order")!.run).toBe(ids.dup);
    const later = Date.now() + RECHECK_MS + 1000;
    const after = await heroProofs(env, later);
    expect(after.find((p) => p.line === "double-order")).toMatchObject({ run: ids["dup-ranked"], ranked: true });
    // The other lines kept their picks.
    for (const p of before.filter((x) => x.line !== "double-order")) expect(after.find((x) => x.line === p.line)!.run).toBe(p.run);
    // An earlier practice run doesn't displace a ranked pick.
    await add("dup-early", { task: "flaky-supplier", fell: ["double_order"], at: t0 - 100 });
    expect((await heroProofs(env, later + RECHECK_MS + 1000)).find((p) => p.line === "double-order")!.run).toBe(ids["dup-ranked"]);
  });

  it("the latest fall is a date from the newest public fall (held, embargoed and held-out runs left out)", async () => {
    await reset();
    // The newest falls are all non-public: they don't count.
    await add("late-embargoed", { task: "refund", fell: ["out_of_policy"], model: EMBARGOED.id, at: t0 + 900 });
    await add("late-held", { task: "refund", fell: ["out_of_policy"], event: ev.held, at: t0 + 901 });
    expect(await latestFall(env)).toBe(t0 + 50);
    const body = await page();
    expect(body).toContain(`Latest AI caught by a trap: <time datetime="${new Date(t0 + 50).toISOString()}">`);
  });
});

describe("one line per visit, then one cycle (ADR 0130)", () => {
  it("picks among every backed line at random (the default picker covers all six)", async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) seen.add(randomIndex(6));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    for (let i = 0; i < 6; i++) {
      const h = await homeHero(env, Date.now(), { random: () => i });
      expect(h.case === "replay" && h.line.key).toBe(HERO_LINES[i]!.key);
    }
  });

  it("each visit's server-rendered line varies through the edge cache, and the share title never does", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 80 && seen.size < 6; i++) {
      const body = await page();
      const line = /data-hero-source="[^"]+" data-hero-line="([a-z-]+)"/.exec(body)?.[1];
      expect(line).toBeTruthy();
      seen.add(line!);
      expect(body).toContain(`<meta property="og:title" content="${HOME_OG_TITLE}">`);
      expect(body).toContain(`<meta name="twitter:title" content="${HOME_OG_TITLE}">`);
    }
    expect([...seen].sort()).toEqual(HERO_LINES.map((l) => l.key).sort());
    expect(HOME_OG_TITLE).toBe("An AI agent paid a fake invoice and reported the job done");
  });

  it("the same address, served from the edge cache (ADR 0125), still opens on different lines across visits", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40 && seen.size < 3; i++) {
      const res = await fetchWorker(`/?n=same-address`, { headers: { Accept: "text/html" } });
      const body = await res.text();
      const line = /data-hero-line="([a-z-]+)"/.exec(body)![1]!;
      expect(res.headers.get("X-Hero-Line")).toBe(line);
      seen.add(line);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it("a `hero` parameter in the address can't choose the line", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40 && seen.size < 2; i++) {
      const body = await (await fetchWorker(`/?hero=hotel&n=forced${i}`, { headers: { Accept: "text/html" } })).text();
      seen.add(/data-hero-line="([a-z-]+)"/.exec(body)![1]!);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("renders the line in the HTML, embeds every line as data, reserves the tallest height, and has a real Pause button", async () => {
    const body = await page();
    const root = /<div class="hero-rot" data-hero-rot data-start="(\d)" data-hero-lines="([^"]+)">/.exec(body)!;
    expect(root).toBeTruthy();
    const data = JSON.parse(root[2]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")) as { key: string; action: string | null; text: string; href: string; run: string; kind: string; name: string }[];
    expect(data.map((d) => d.key)).toEqual(HERO_LINES.map((l) => l.key));
    expect(data.map((d) => d.text)).toEqual(HERO_LINES.map(lineText));
    for (const d of data) expect(d.href).toBe(`/arena/run/${d.run}?from=home-source-${d.key}`);
    const shown = data[Number(root[1])]!;
    // The h1 holds only the current line (its accessible name), never announced.
    // HTML-escaped in the page ("wasn't" → "wasn&#39;t"); the line is picked at random, so decode before comparing.
    const unescape = (x: string) => x.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const h1 = unescape(/<h1 aria-live="off">(.*?)<\/h1>/.exec(body)![1]!);
    expect(h1.replace(/<[^>]+>/g, "")).toBe(shown.text);
    if (shown.action) expect(h1).toContain(`<span class="hero-act">${shown.action}</span> and <em>reported the job done</em>.`);
    // Hidden copies of all six lines and their sources hold the tallest height (CLS 0); hidden from readers and snippets.
    expect(body.match(/<p class="hero-size hero-size-h1" aria-hidden="true" data-nosnippet>/g)).toHaveLength(6);
    expect(body.match(/<p class="small hero-source hero-size" aria-hidden="true" data-nosnippet>/g)).toHaveLength(6);
    // A small control beside the source line, not a full-size button; its name is the label text.
    expect(body).toContain('<button type="button" class="hero-pause hero-pause-off" data-hero-pause aria-pressed="false"><span class="hero-ico" aria-hidden="true"></span><span class="hero-lbl" data-hero-pause-label>Pause headlines</span></button></div>');
    expect(body).toMatch(/<div class="hero-srcrow"><div class="hero-cell"><p class="small hero-source" data-hero-source=/);
    expect(body).not.toMatch(/class="btn[^"]*hero-pause/);
    expect(body).toContain('<script type="module" src="/hero-lines.js"></script>');
    // The source line matches the shown line.
    expect(body).toContain(`data-hero-source="${shown.run}" data-hero-line="${shown.key}"`);
    expect(body).not.toContain(MODEL_WORDS);
    expect(body).not.toMatch(SHOWS_EMBARGOED);
  });

  it("the static strip links every backed line's replay, in the strip's order", async () => {
    const body = await page();
    const strip = /<p class="small hero-strip" data-hero-strip>(.*?)<\/p>/.exec(body)![1]!;
    expect(strip).toMatch(/^<span class="muted">Caught in refereed runs:<\/span> /);
    const links = [...strip.matchAll(/<a href="\/arena\/run\/([0-9a-f-]+)\?from=home-strip-([a-z-]+)" data-strip-line="[a-z-]+">([^<]+)<\/a>/g)];
    expect(links.map((m) => m[2])).toEqual([...STRIP_ORDER]);
    const ps = await heroProofs(env);
    for (const m of links) expect(ps.find((p) => p.line === m[2])!.run).toBe(m[1]);
    expect(links.map((m) => m[3])).toEqual(STRIP_ORDER.map((k) => HERO_LINES.find((l) => l.key === k)!.strip.replace(/“/g, "“")));
  });

  it("the JSON twin says which line was shown and lists every backed line; fixed_source stays the fake invoice", async () => {
    const shownLines = new Set<string>();
    for (let i = 0; i < 30 && shownLines.size < 2; i++) {
      const j = (await (await fetchWorker(`/?format=json&n=lines-j${i}`)).json()) as { hero: { headline: string; headline_source: Record<string, unknown> & { lines: { line: string; replay_url: string; text: string }[] }; fixed_source: Record<string, unknown> } };
      const src = j.hero.headline_source;
      shownLines.add(src.line as string);
      expect(j.hero.headline).toBe(src.text);
      expect(src).toMatchObject({ case: "replay", status: "found", selection: "one_backed_line_at_random_per_visit" });
      expect(src.lines.map((l) => l.line)).toEqual(HERO_LINES.map((l) => l.key));
      for (const l of src.lines) expect(l.replay_url).toMatch(new RegExp(`^${env.PUBLIC_ORIGIN}/arena/run/[0-9a-f-]+$`));
      expect(j.hero.fixed_source).toMatchObject({ status: "found", line: "invoice", run: ids.invoice, trap_id: "FA-INJ-001" });
      expect(JSON.stringify(j)).not.toContain(MODEL_WORDS);
    }
    expect(shownLines.size).toBeGreaterThan(1);
  });

  it("only one backed line: no script, no button, no strip (nothing to cycle)", async () => {
    // A fresh state with only the invoice pin: the other picks are gone (their runs re-held for this test).
    await getDb(env).update(t.arenaEvents).set({ status: "planned" }).where(eqId(ev.practice));
    await add("solo", { task: "scam-invoice", fell: ["paid_scam"], event: ev.ranked, at: t0 + 60 });
    await reset();
    const ps = await heroProofs(env);
    expect(ps.map((p) => p.line)).toEqual(["invoice", "double-order"]);
    await getDb(env).update(t.arenaRuns).set({ heldOut: true }).where(eqRun(ids["dup-ranked"]!));
    await reset();
    expect((await heroProofs(env)).map((p) => p.line)).toEqual(["invoice"]);
    const body = await page();
    expect(body).toContain('<h1 aria-live="off">An AI agent <span class="hero-act">paid a fake invoice</span> and <em>reported the job done</em>.</h1>');
    expect(body).not.toContain("data-hero-rot");
    expect(body).not.toContain("data-hero-pause");
    expect(body).not.toContain("data-hero-strip");
    expect(body).not.toContain("/hero-lines.js");
    // Put the fixtures back for the tests below.
    await getDb(env).update(t.arenaEvents).set({ status: "done" }).where(eqId(ev.practice));
    await getDb(env).update(t.arenaRuns).set({ heldOut: false }).where(eqRun(ids["dup-ranked"]!));
    await reset();
  });
});

const eqId = (id: string) => eq(t.arenaEvents.id, id);
const eqRun = (id: string) => eq(t.arenaRuns.id, id);

describe("internal measurement (admin only)", () => {
  it("counts the replay click from a line's source link or strip item, people only", async () => {
    const u = (q: string) => new URL(`${env.PUBLIC_ORIGIN}/arena/run/${ids.dup}?from=${q}`);
    expect(heroClickCounters(u("home-source-double-order"))).toEqual(["hero:click:double-order"]);
    expect(heroClickCounters(u("home-strip-hotel"))).toEqual(["hero:strip:hotel"]);
    expect(heroClickCounters(u("home-source-nope"))).toEqual([]);
    expect(heroClickCounters(u("home-source"))).toEqual([]);
    expect(heroClickCounters(new URL(`${env.PUBLIC_ORIGIN}/arena?from=home-source-hotel`))).toEqual([]);
    const headers = { ...BROWSER, referer: `${env.PUBLIC_ORIGIN}/` };
    await fetchWorker(`/arena/run/${ids.dup}?from=home-source-double-order`, { headers });
    await fetchWorker(`/arena/run/${ids.hotel}?from=home-strip-hotel`, { headers });
    // A crawler's visit adds nothing.
    await fetchWorker(`/arena/run/${ids.dup}?from=home-source-double-order`, { headers: { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" } });
    // A person's home page view counts the line it opened on.
    await fetchWorker(`/?n=shown1`, { headers });
    await vi.waitFor(async () => {
      const s = await heroLineStats(env);
      expect(s.lines.find((l) => l.key === "double-order")!.clicks).toBe(1);
      expect(s.lines.find((l) => l.key === "hotel")!.strip_clicks).toBe(1);
      expect(s.lines.reduce((a, l) => a + l.shown, 0)).toBe(1);
    });
    const panel = heroLinesPanel(await heroLineStats(env)).toString();
    expect(panel).toContain("Home headline lines (ADR 0130)");
    expect(panel).toContain("Never shown publicly.");
    // Public pages never carry these numbers.
    expect(await page()).not.toContain("Shown first");
  });
});

describe("the one-cycle script (public/hero-lines.js)", () => {
  const tick = (s: HeroRotState) => update(s, { type: "tick" });
  it("runs one cycle through the others and stops on the line it started with", () => {
    expect(cycleOrder(2, 6)).toEqual([3, 4, 5, 0, 1, 2]);
    expect(cycleOrder(0, 1)).toEqual([]);
    let s = initial(4, 1, false);
    expect(running(s)).toBe(true);
    const shown: number[] = [];
    for (let i = 0; i < 10; i++) {
      s = tick(s);
      shown.push(s.current);
    }
    expect(shown.slice(0, 4)).toEqual([2, 3, 0, 1]);
    expect(new Set(shown.slice(3))).toEqual(new Set([1]));
    expect(s.playing).toBe(false);
    expect(buttonState(s)).toEqual({ label: "Play headlines", pressed: true });
    // Play again: one more cycle from where it is.
    s = update(s, { type: "toggle" });
    expect(s.playing).toBe(true);
    expect(tick(s).current).toBe(2);
  });

  it("pauses on hover, keyboard focus, a hidden tab or the button, and resumes from the same line", () => {
    let s = initial(3, 0, false);
    for (const k of ["hover", "focus", "hidden"] as const) {
      s = update(s, { type: k, on: true });
      expect(running(s), k).toBe(false);
      expect(tick(s).current, k).toBe(0);
      s = update(s, { type: k, on: false });
      expect(running(s), k).toBe(true);
    }
    s = update(s, { type: "toggle" });
    expect(buttonState(s)).toEqual({ label: "Play headlines", pressed: true });
    expect(tick(s).current).toBe(0);
    s = update(s, { type: "toggle" });
    expect(buttonState(s)).toEqual({ label: "Pause headlines", pressed: false });
    expect(tick(s).current).toBe(1);
  });

  it("with reduced motion nothing moves until Play is pressed", () => {
    let s = initial(5, 3, true);
    expect(running(s)).toBe(false);
    expect(tick(s).current).toBe(3);
    expect(buttonState(s).label).toBe("Play headlines");
    s = update(s, { type: "toggle" });
    expect(tick(s).current).toBe(4);
  });

  it("swaps only the action phrase when both lines share the frame; times are ~4.5 s per line and a ≤300 ms fade", () => {
    expect(sameFrame({ action: "a" }, { action: "b" })).toBe(true);
    expect(sameFrame({ action: "a" }, { action: null })).toBe(false);
    expect(STEP_MS).toBe(4500);
    expect(FADE_MS).toBeLessThanOrEqual(300);
    // Vanilla, no network, no HTML strings, no live announcements.
    expect(heroScript).not.toMatch(/\bfetch\(|XMLHttpRequest|innerHTML|import\s|aria-live="polite"/);
    expect(heroScript).toContain('prefers-reduced-motion: reduce');
    expect(heroScript).toContain("visibilitychange");
  });
});
