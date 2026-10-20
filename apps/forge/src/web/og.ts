import { CustomFont, ImageResponse, cache } from "@cf-wasm/og/workerd";
import { isLean } from "../services/ops-mode";
import { scanByFingerprint } from "../services/scans";
import type { DisplayVerdict } from "@forge/shared";
import type { Context } from "hono";
import { getDb } from "../services/db";
import { findTool } from "../services/forge";
import { cardVersion, toolCardFields } from "./og-data";
import { agentDetail } from "./queries";
import { HOME_H1, site } from "./pages";
import { parseWeights, rankModels, summaryLines, taskById, TRAP_FAMILIES, type AttemptResult, type Duel } from "@forge/arena";
import { TRAP_CARD_VERSION, TRAP_CHECKS } from "@forge/shared";
import { channelDuels } from "../arena/featured";
import { modelName, runWithLog, taskBoard } from "../arena/views";
import { stampOf } from "./duel";
import { labTotals } from "./home-wire";
import { PLAY, robotSvg, stampWord, svgAt } from "../../public/gauntlet.js";
import { failCard, verifiedReplay, type CardKind } from "../arena/fail-card";
import { trapBoard } from "../arena/failures";

// Share cards, 1200×630 (docs/BRAND.md §9). The verdict, subject and domain are burned into the image, because X shows
// large cards without the page title. Built from plain element objects (no HTML parsing), so nothing user-supplied can
// inject markup.

type Ctx = Context<{ Bindings: Env }>;
type Node = { type: string; props: Record<string, unknown> & { style?: Record<string, unknown>; children?: unknown } };

const C = {
  bg: "#0B0E12",
  surface: "#131820",
  seam: "#2A3340",
  text: "#E8ECF1",
  muted: "#9AA5B4",
  brand: "#4AA8FF",
  clear: "#3DDC97",
  caution: "#F5B83D",
  flagged: "#FF5D52",
  insufficient: "#8A94A3",
};
const VERDICT_COLOR: Record<DisplayVerdict, string> = {
  clear: C.clear,
  caution: C.caution,
  flagged: C.flagged,
  confirmed_malicious: C.flagged,
  insufficient: C.insufficient,
};
const VERDICT_TEXT: Record<DisplayVerdict, string> = {
  clear: "Clear",
  caution: "Caution: security report under review",
  flagged: "Flagged by independent verified agents",
  confirmed_malicious: "Confirmed malicious",
  insufficient: "Not enough reports yet",
};

const PUNCH = "M5 0 H29 L34 5 V35 L29 40 H5 L0 35 V5 Z";
const ICON: Record<DisplayVerdict | "F", string> = {
  F: "M9 8 V32 H15.5 V23.5 H24 V17.5 H15.5 V14 H26 V8 Z",
  clear: "M5.5 20.5 L10 16 L14.5 20.5 L25 10 L29.5 14.5 L14.5 29.5 Z",
  caution: "M14 7 H20 V25 H14 Z M14 28 H20 V33 H14 Z",
  flagged: "M10 7 H14 V33 H10 Z M14 8 H26 L22 13.5 L26 19 H14 Z",
  confirmed_malicious: "M9.5 13.5 L13.5 9.5 L17 13 L20.5 9.5 L24.5 13.5 L21 17 L24.5 20.5 L20.5 24.5 L17 21 L13.5 24.5 L9.5 20.5 L13 17 Z",
  insufficient: "M8 17.5 H26 V22.5 H8 Z",
};

const el = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({
  type,
  props: { style, children, ...extra },
});

function punch(size: number, color: string, icon: string): Node {
  return el(
    "svg",
    { width: size * 0.85, height: size },
    [el("path", {}, undefined, { d: `${PUNCH} ${icon}`, fill: color, "fill-rule": "evenodd" })],
    { viewBox: "0 0 34 40", width: size * 0.85, height: size },
  );
}

function frame(children: Node[], footer: string): Node {
  return el(
    "div",
    { display: "flex", flexDirection: "column", width: "100%", height: "100%", background: C.bg, padding: "56px 72px", color: C.text, fontFamily: "Archivo" },
    [
      el("div", { display: "flex", alignItems: "center", gap: "16px" }, [
        punch(56, C.text, ICON.F),
        punch(56, C.brand, ICON.clear),
        el("div", { display: "flex", flexDirection: "column", marginLeft: "8px" }, [
          el("span", { fontSize: 18, color: C.muted, fontFamily: "Archivo Expanded", letterSpacing: "2px" }, "THE"),
          el("span", { fontSize: 32, fontFamily: "Archivo Expanded", lineHeight: 1 }, "AGENT FORGE"),
        ]),
      ]),
      el("div", { display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }, children),
      el("div", { display: "flex", justifyContent: "space-between", borderTop: `2px solid ${C.seam}`, paddingTop: "22px", fontFamily: "JetBrains Mono", fontSize: 24 }, [
        el("span", { color: C.muted }, "AI, tested on everyday jobs."),
        el("span", { color: C.brand }, footer),
      ]),
    ],
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

let fonts: CustomFont[] | null = null;
function loadFonts(env: Env) {
  const load = (path: string) => async () => (await env.ASSETS.fetch(new Request(`https://assets.local${path}`))).arrayBuffer();
  fonts ??= [
    new CustomFont("Archivo Expanded", load("/og-fonts/archivo-expanded-800.ttf"), { weight: 800 }),
    new CustomFont("Archivo", load("/og-fonts/archivo-500.ttf"), { weight: 500 }),
    new CustomFont("JetBrains Mono", load("/og-fonts/jetbrains-mono-500.ttf"), { weight: 500 }),
  ];
  return fonts;
}

/** Content-addressed cards are immutable; the page links to the current version with ?v=<hash>. */
async function respond(c: Ctx, node: Node) {
  // Cost guard (ADR 0027): in lean mode, no new drawing; the site-wide card is a static file.
  if (await isLean(c.env)) return c.redirect("/og/site.png", 302);
  cache.setExecutionContext(c.executionCtx as unknown as ExecutionContext);
  const res = await ImageResponse.async(node as never, { width: 1200, height: 630, fonts: loadFonts(c.env) });
  const headers = new Headers(res.headers);
  headers.set("Content-Type", "image/png");
  headers.set("Cache-Control", c.req.query("v") ? "public, max-age=31536000, immutable" : "public, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(res.body, { status: 200, headers });
}

site.get("/og/t/:file{.+\\.png}", async (c) => {
  let id: string;
  try {
    id = decodeURIComponent(c.req.param("file").replace(/\.png$/, ""));
  } catch {
    return c.redirect("/og/home.png", 302);
  }
  const tool = await findTool(getDb(c.env), id);
  if (!tool) return c.redirect("/og/home.png", 302);
  const { check, v, version } = await toolCardFields(c.env, tool.canonicalId);
  // Only the current card is served as immutable; an old or made-up ?v= redirects, so it can't fill the cache.
  const asked = c.req.query("v");
  if (asked !== undefined && asked !== version) return c.redirect(`/og/t/${encodeURIComponent(tool.canonicalId)}.png?v=${version}`, 302);
  const color = VERDICT_COLOR[v];
  const people =
    check.distinct_owners === 0
      ? "No field reports yet"
      : `${check.distinct_owners} ${check.distinct_owners === 1 ? "person" : "people"} reported · ${check.verified_owners} verified`;
  return respond(
    c,
    frame(
      [
        el("div", { fontFamily: "JetBrains Mono", fontSize: tool.canonicalId.length > 40 ? 40 : 52, color: C.text, marginBottom: "28px" }, clip(tool.canonicalId, 56)),
        el("div", { display: "flex", alignItems: "center", gap: "20px", marginBottom: "18px" }, [
          punch(72, color, ICON[v]),
          el("div", { display: "flex", flexDirection: "column" }, [
            el("span", { fontFamily: "Archivo Expanded", fontSize: 40, color }, VERDICT_TEXT[v]),
            el(
              "span",
              { fontFamily: "JetBrains Mono", fontSize: 26, color: C.muted },
              v === "flagged" || v === "caution" || v === "confirmed_malicious"
                ? `${check.verified_owners} verified ${check.verified_owners === 1 ? "person" : "people"} reported a security issue`
                : check.forge_score !== null
                  ? `Forge Score ${check.forge_score}`
                  : "Score appears at 5 people, 2 verified",
            ),
          ]),
        ]),
        el("div", { fontFamily: "JetBrains Mono", fontSize: 26, color: C.muted }, `${people}${check.version ? ` · v${clip(check.version, 20)}` : ""}`),
      ],
      `theagentforge.io/t/${clip(tool.canonicalId, 30)}`,
    ),
  );
});

site.get("/og/a/:file{.+\\.png}", async (c) => {
  const handle = c.req.param("file").replace(/\.png$/, "");
  const d = await agentDetail(getDb(c.env), handle);
  if (!d) return c.redirect("/og/home.png", 302);
  const version = await cardVersion([d.agent.handle, d.reports.length, d.corroborated, d.earlyWarnings, d.ownerTier]);
  const asked = c.req.query("v");
  if (asked !== undefined && asked !== version) return c.redirect(`/og/a/${encodeURIComponent(d.agent.handle)}.png?v=${version}`, 302);
  const stat = (n: number, label: string) =>
    el("div", { display: "flex", flexDirection: "column", marginRight: "56px" }, [
      el("span", { fontFamily: "JetBrains Mono", fontSize: 64, color: C.text }, String(n)),
      el("span", { fontSize: 24, color: C.muted }, label),
    ]);
  return respond(
    c,
    frame(
      [
        el("div", { fontFamily: "JetBrains Mono", fontSize: 56, marginBottom: "8px" }, clip(d.agent.handle, 32)),
        el("div", { fontSize: 28, color: C.muted, marginBottom: "36px" }, `${d.agent.framework} agent · run by @${clip(d.ownerLogin, 30)}${d.ownerTier === "verified" ? " · verified" : ""}`),
        el("div", { display: "flex" }, [stat(d.reports.length, "field reports"), stat(d.corroborated, "confirmed findings"), stat(d.earlyWarnings, "early warnings")]),
      ],
      `theagentforge.io/a/${clip(d.agent.handle, 30)}`,
    ),
  );
});

// Arena, task guide and trap card images (ADR 0018 §4). Every line is template text filled from referee results
// (model names, task titles, our own trap labels, verdicts): never anything a model wrote.

const line = (s: string, size = 26, color = C.muted) => el("div", { display: "flex", fontFamily: "JetBrains Mono", fontSize: size, color, marginBottom: "18px" }, s);
const headline = (s: string, size = 60) => el("div", { display: "flex", fontFamily: "Archivo Expanded", fontSize: size, lineHeight: 1.08, marginBottom: "30px" }, s);

/** The default share image: the home headline and today's featured bout as a score bug. */
export function homeCardLines(duel: Duel | undefined) {
  if (!duel) return { headline: HOME_H1, bug: null, title: null, sides: [] as { name: string; stamp: string; good: boolean }[] };
  const sides = [duel.a, duel.b].map((s) => ({ name: s.name, stamp: stampOf(s).text, good: stampOf(s).cls === "stamp-caught" }));
  const title = `${duel.practice ? "Practice · " : ""}${duel.title.replace(/^The /, "")}`;
  return { headline: HOME_H1, title, sides, bug: `${title} · ${sides.map((x) => `${x.name}: ${x.stamp}`).join(" · ")}` };
}

/** The Gauntlet robot on a lighter tile (its dark visor would vanish on the card background). */
function robotTile(mood: "pass" | "fell" | "alert", border: string, size = 200): Node {
  const src = `data:image/svg+xml;base64,${btoa(robotSvg(mood, size))}`;
  return el("div", { display: "flex", padding: "18px", background: "#1C2430", border: `3px solid ${border}`, borderRadius: "6px" }, [el("img", { width: size, height: size }, undefined, { src, width: size, height: size })]);
}

/** The launch report's card (ADR 0026): the numbers from the report, with the Skill Watch robot mid-check. */
site.get("/og/reports/skill-scan-2026-10.png", (c) =>
  respond(
    c,
    frame(
      [
        el("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
          el("div", { display: "flex", flexDirection: "column", width: "780px" }, [
            el("div", { display: "flex", fontFamily: "JetBrains Mono", fontSize: 26, color: C.caution, marginBottom: "18px" }, "SKILL WATCH · REPORT · OCT 2026"),
            headline("We scanned 9,930 public AI agent skills.", 50),
            line("14 pipe a download straight into a shell.", 28, C.text),
            line("8 read the agent's whole key file.", 28, C.text),
            line("No confirmed malware. The dataset is public.", 26),
          ]),
          robotTile("alert", C.caution),
        ]),
      ],
      "theagentforge.io/reports",
    ),
  ),
);

/** Forge Lab #3's card: the three arms as bars, counts summed from the published counts.json (via labTotals). */
site.get("/og/lab/3.png", (c) => {
  const t = labTotals();
  const bar = (label: string, v: number, color: string) =>
    el("div", { display: "flex", alignItems: "center", gap: "18px", marginBottom: "16px", fontFamily: "JetBrains Mono", fontSize: 26, color: color === C.clear ? C.clear : C.text }, [
      el("span", { display: "flex", width: "220px" }, label),
      el("div", { display: "flex", width: "520px", height: "30px", background: C.surface, border: `2px solid ${C.seam}` }, [el("div", { display: "flex", width: `${v}%`, height: "100%", background: color }, "")]),
      el("span", { display: "flex", width: "160px", justifyContent: "flex-end" }, `${v} in 100`),
    ]);
  return respond(
    c,
    frame(
      [
        el("div", { display: "flex", fontFamily: "JetBrains Mono", fontSize: 24, color: C.caution, marginBottom: "14px" }, "FORGE LAB #3 · PRE-REGISTERED"),
        headline(`${t.fewer}% fewer traps with the free trap card.`, 46),
        el("div", { display: "flex", flexDirection: "column", marginTop: "6px" }, [bar("No card", t.in100.none, C.insufficient), bar("Placebo text", t.in100.placebo, C.insufficient), bar("Trap card", t.in100.card, C.clear)]),
        line(`Small open models, new versions of the jobs · ${t.card.n} bouts per arm`, 22),
      ],
      "theagentforge.io/lab/3/results",
    ),
  );
});

/** The finished Trap Gauntlet frame (the same drawing the site plays) as an image for a share card. The card renderer
 * draws no text inside an SVG image, so the lane names and verdict stamps are laid over it as real text. */
export function gauntletImage(duel: Duel, size: number): Node | null {
  if (!duel.gauntlet) return null;
  const svg = svgAt(duel.gauntlet, PLAY, { geo: "compact", label: duel.headline ?? duel.title });
  const src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
  const k = size / 600; // the compact drawing is 600 × 600
  const laneY = [175, 455];
  const stampX = 228;
  const over = duel.gauntlet.lanes.map((lane, i) => {
    const bad = lane.fell || lane.verdict !== "PASS";
    const color = bad ? C.flagged : C.clear;
    const y = laneY[i]!;
    return [
      el("div", { position: "absolute", left: 36 * k, top: (y - 106) * k, display: "flex", fontFamily: "JetBrains Mono", fontSize: 18 * k, color: C.text }, `[${i ? "B" : "A"}] ${clip(lane.name, 24)}`),
      el("div", { position: "absolute", left: (stampX - 150) * k, top: (y - 76) * k, width: 300 * k, height: 60 * k, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Archivo Expanded", fontSize: 26 * k, color }, stampWord(lane)),
    ];
  }).flat();
  return el("div", { display: "flex", position: "relative", width: size, height: size }, [el("img", { width: size, height: size }, undefined, { src, width: size, height: size }), ...over]);
}

site.get("/og/home.png", async (c) => {
  const duel = (await channelDuels(c.env, getDb(c.env)).catch(() => []))[0];
  const l = homeCardLines(duel);
  const art = duel ? gauntletImage(duel, 400) : null;
  // ADR 0029: the headline beside today's Gauntlet, robots and all; the old text score bug only if there's no art.
  if (art && duel) {
    const left = el("div", { display: "flex", flexDirection: "column", width: "600px", justifyContent: "center" }, [
      headline(l.headline, 50),
      el("div", { display: "flex", fontFamily: "JetBrains Mono", fontSize: 24, color: C.caution, marginBottom: "12px" }, "Same job, same hidden trap."),
      el("div", { display: "flex", fontFamily: "JetBrains Mono", fontSize: 24, color: C.muted }, clip(duel.headline ?? "Watch who falls for it.", 90)),
    ]);
    return respond(c, frame([el("div", { display: "flex", justifyContent: "space-between", alignItems: "center" }, [left, art])], "theagentforge.io"));
  }
  const bug = l.title
    ? [
        el("div", { display: "flex", flexDirection: "column", borderLeft: `6px solid ${C.brand}`, paddingLeft: "18px" }, [
          el("div", { display: "flex", fontFamily: "JetBrains Mono", fontSize: 24, color: C.muted, marginBottom: "8px" }, clip(l.title, 60)),
          el(
            "div",
            { display: "flex", fontFamily: "JetBrains Mono", fontSize: 28, gap: "28px" },
            l.sides.map((x) => el("div", { display: "flex", gap: "12px" }, [el("span", { color: C.text }, clip(x.name, 22)), el("span", { color: x.good ? C.clear : C.flagged }, x.stamp)])),
          ),
        ]),
      ]
    : [];
  return respond(c, frame([headline(l.headline, 64), ...bug], "theagentforge.io"));
});

/** One refereed attempt: verdict, the template summary line, task, date and whether it was practice. */
export function runCardLines(r: { modelName: string; result: AttemptResult; taskTitle: string; practice: boolean; finishedAt: number }) {
  const verdict = r.result.passed ? "PASS" : r.result.reason.startsWith("knockout") ? "KO" : "FAIL";
  return {
    verdict,
    meta: `${r.practice ? "Practice · " : ""}${r.taskTitle} · refereed replay · ${new Date(r.finishedAt).toISOString().slice(0, 10)}`,
    summary: summaryLines(r.modelName, r.result)[0],
  };
}

/** The fail card's label above the sentence, by kind. */
export const CARD_LABEL: Record<CardKind, string> = { trap: "TRAP", caught: "TRAP CAUGHT", knockout: "KNOCKOUT", claimed: "FAIL", fail: "FAIL", pass: "PASS" };

/**
 * The fail card (ADR 0023 §1): the template sentence, the trap or task id, the date, "Verified replay" and the short
 * link. Served at /og/arena/run/<id>/card.png and, for links already posted, at /og/arena/run/<id>.png.
 */
async function failCardImage(c: Ctx, id: string) {
  const r = await runWithLog(getDb(c.env), id);
  if (!r) return c.redirect("/og/home.png", 302);
  const taskTitle = taskById(r.run.task)?.title ?? r.run.task;
  const card = failCard({ runId: r.run.id, modelName: modelName(r.run.modelId), result: r.result, taskTitle, practice: r.event.kind === "practice", finishedAt: r.run.finishedAt ?? Date.now() });
  const ok = await verifiedReplay(c.env, r.run.id, r.log, r.run.signature);
  const good = card.kind === "caught" || card.kind === "pass";
  const color = good ? C.clear : card.kind === "knockout" ? C.caution : C.flagged;
  const size = card.sentence.length <= 44 ? 52 : card.sentence.length <= 80 ? 42 : 34;
  // ADR 0029: the Gauntlet robot beside the verdict, happy after a pass, sheepish after a fall. No text in it.
  const bot = robotTile(good ? "pass" : "fell", color);
  return respond(
    c,
    frame(
      [
        el("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
        el("div", { display: "flex", flexDirection: "column", width: "800px" }, [
        el("div", { display: "flex", alignItems: "center", gap: "16px", marginBottom: "22px", fontFamily: "JetBrains Mono", fontSize: 26 }, [
          ...(card.practice ? [el("span", { display: "flex", border: `2px solid ${C.caution}`, color: C.caution, padding: "2px 12px" }, "Practice")] : []),
          punch(40, color, good ? ICON.clear : ICON.flagged),
          el("span", { color }, CARD_LABEL[card.kind]),
          el("span", { color: C.muted }, clip(card.shortId, 44)),
        ]),
        el("div", { display: "flex", fontFamily: "Archivo Expanded", fontSize: size, lineHeight: 1.12, marginBottom: "26px" }, clip(card.sentence, 140)),
        line(`${clip(taskTitle, 40)} · ${card.dated}${card.moreTraps ? ` · and ${card.moreTraps} more ${card.moreTraps === 1 ? "trap" : "traps"}` : ""}`),
        line(ok ? "Verified replay" : "Replay not verified", 26, ok ? C.clear : C.muted),
        ]),
        bot,
        ]),
      ],
      card.shortLink,
    ),
  );
}

site.get("/og/arena/run/:id{[A-Za-z0-9_-]+}/card.png", (c) => failCardImage(c, c.req.param("id")));
site.get("/og/arena/run/:file{[A-Za-z0-9_-]+\\.png}", (c) => failCardImage(c, c.req.param("file").replace(/\.png$/, "")));

site.get("/og/best/:file{[a-z-]+\\.png}", async (c) => {
  const task = taskById(c.req.param("file").replace(/\.png$/, ""));
  if (!task) return c.redirect("/og/home.png", 302);
  const db = getDb(c.env);
  let rows = await taskBoard(db, task.id);
  const practice = !rows.length;
  if (practice) rows = await taskBoard(db, task.id, true);
  const runs = rows.reduce((n, r) => n + r.stats.runs, 0);
  const top = rankModels(rows, parseWeights(undefined))[0];
  return respond(
    c,
    frame(
      [
        headline(`${task.title}: which AI should you use?`, 52),
        line(`${practice ? "Early read, practice data" : "Refereed results"} · ${runs} ${runs === 1 ? "run" : "runs"} · ${new Date().toISOString().slice(0, 10)}`),
        ...(top ? [line(`Top so far: ${clip(top.item.name, 40)}${top.trapped ? " (fell for a trap)" : ""}`, 30, C.text)] : []),
      ],
      `theagentforge.io/best/${task.id}`,
    ),
  );
});

site.get("/og/trap-card.png", (c) =>
  respond(c, frame([headline("Give your AI the checks others missed.", 58), line(`Free trap card v${TRAP_CARD_VERSION} · ${TRAP_CHECKS.length} checks · paste once, about 30 seconds`)], "theagentforge.io/trap-card")),
);

/**
 * A failure-mode card (ADR 0023 §4): the trap's public ID and family, our catalog description, and the ranked fall
 * rate across models with n (and "Early read" under the verdict threshold). Template text only.
 */
export function failureCardLines(b: NonNullable<Awaited<ReturnType<typeof trapBoard>>>) {
  const o = b.overall;
  const worst = b.models[0];
  return {
    label: `FAILURE MODE · ${b.entry.id}`,
    family: TRAP_FAMILIES[b.entry.family].name,
    headline: b.entry.description,
    stat: o ? `Fell for it in ${o.fell} of ${o.n} ranked attempts (${Math.round(o.rate * 100)}%) · ${b.models.length} ${b.models.length === 1 ? "model" : "models"}${o.early ? " · Early read" : ""}` : "No ranked attempts yet",
    worst: worst && worst.cell.fell ? `Highest so far: ${worst.name}, ${worst.cell.fell} of ${worst.cell.n}` : null,
  };
}

site.get("/og/arena/failures/:file{[A-Za-z]+-[A-Za-z]+-[0-9]+\\.png}", async (c) => {
  const b = await trapBoard(getDb(c.env), c.req.param("file").replace(/\.png$/, "").toUpperCase());
  if (!b) return c.redirect("/og/home.png", 302);
  const l = failureCardLines(b);
  return respond(
    c,
    frame(
      [
        el("div", { display: "flex", alignItems: "center", gap: "16px", marginBottom: "22px", fontFamily: "JetBrains Mono", fontSize: 26 }, [
          punch(40, C.flagged, ICON.flagged),
          el("span", { color: C.flagged }, l.label),
          el("span", { color: C.muted }, clip(l.family, 40)),
        ]),
        el("div", { display: "flex", fontFamily: "Archivo Expanded", fontSize: l.headline.length <= 70 ? 48 : 40, lineHeight: 1.12, marginBottom: "26px" }, clip(l.headline, 130)),
        line(l.stat, 26, C.text),
        ...(l.worst ? [line(clip(l.worst, 70))] : []),
      ],
      `theagentforge.io/arena/failures/${b.entry.id}`,
    ),
  );
});

/**
 * A skill scan card (ADR 0026), the share artifact: verdict, counts and the titles of the rules that fired. Template
 * text only: rule titles are ours, and the only outside text is the source path from a public URL, clipped.
 */
site.get("/og/scan/:file{[0-9a-f]{64}\\.png}", async (c) => {
  const row = await scanByFingerprint(getDb(c.env), `sha256:${c.req.param("file").replace(/\.png$/, "")}`);
  if (!row || !row.public) return c.redirect("/og/site.png", 302);
  const v = row.verdict as "flagged" | "caution" | "clear";
  const counts = row.counts as { high: number; medium: number; low: number };
  const titles = [...new Set((row.findings as { title: string }[]).map((f) => f.title))].slice(0, 3);
  const src = row.sourceUrl ? row.sourceUrl.replace(/^https:\/\/(raw\.githubusercontent\.com|[^/]+)\//, "") : (row.name ?? "pasted skill");
  const head = v === "flagged" ? "Flagged before install" : v === "caution" ? "Worth a look before install" : "No known risky patterns";
  return respond(
    c,
    frame(
      [
        el("div", { fontFamily: "JetBrains Mono", fontSize: 30, color: C.muted, marginBottom: "18px" }, `SKILL SCAN · ${clip(src, 52)}`),
        el("div", { display: "flex", alignItems: "center", gap: "20px", marginBottom: "24px" }, [
          punch(72, VERDICT_COLOR[v], ICON[v]),
          el("span", { fontFamily: "Archivo Expanded", fontSize: 50, color: VERDICT_COLOR[v] }, head),
        ]),
        ...titles.map((t) => line(`· ${clip(t, 60)}`, 28, C.text)),
        line(`${counts.high} high · ${counts.medium} medium · ${counts.low} low · rules ${row.rulesVersion}`),
      ],
      "theagentforge.io/scan",
    ),
  );
});
