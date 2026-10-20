// The Trap Gauntlet player (ADR 0029). One deterministic renderer, used twice: the Worker imports it to draw the
// finished frame (works without JavaScript), and the browser plays it with svgAt(script, t) on every frame. Two
// pixel robots run the same job as a course, one tile per real tool call; the viewer can see the trap tile; the
// trapdoor only opens when the referee checks. No randomness, no model-written text, no network calls.

export const PLAY = 16; // seconds of play before the hold
export const HOLD = 4;
const T_RUN = 1.6; // course starts
const T_TRAP = 7.2; // both robots reach the trap tile together
const T_FINISH = 11; // both at the finish line
const T_CHECK = 11.6; // "referee checking…"
const T_VERDICT = 12.8; // stamp, trapdoor
const T_REPLAY = 13.8; // replay line

// Two canvases: wide (desktop, beside the terminal) and compact (phones), so robots and tiles stay big enough to read.
const GEO = {
  wide: { W: 1000, H: 520, laneY: [150, 390], x0: 70, xf: 900, px: 5, tile: 44, stampX: 560 },
  compact: { W: 600, H: 600, laneY: [175, 455], x0: 36, xf: 512, px: 5, tile: 38, stampX: 300 },
};
// Same body for both corners (no team colours); they differ by antenna, and names are labels. Green, red and amber
// belong to the referee and the trap.
export const ANTENNA = ["ball", "fork"];
export const LANE_TAG = ["A", "B"];
const C = { bg: "#0B0E12", surface: "#131820", seam: "#2A3340", text: "#E8ECF1", muted: "#9AA5B4", pass: "#3DDC97", fail: "#FF5D52", warn: "#F5B83D", brand: "#4AA8FF", dark: "#0B0E12" };

// ---------- the robot: 16×16 pixels, 1 body colour + dark visor + bright eyes ----------
const BODY = [
  ".......AA.......",
  ".......BB.......",
  "...BBBBBBBBBB...",
  "..BBBBBBBBBBBB..",
  "..BBDDDDDDDDBB..",
  "..BBDDDDDDDDBB..",
  "..BBDDDDDDDDBB..",
  "..BBDDDDDDDDBB..",
  "..BBBBBBBBBBBB..",
  "...BBBBBBBBBB...",
  "....BBBBBBBB....",
  "..BBBBBBBBBBBB..",
  "..B.BBBBBBBB.B..",
  "....BBBBBBBB....",
];
const LEGS = { apart: ["....BB....BB....", "...BBB....BBB..."], together: [".....BB..BB.....", ".....BB..BB....."], tuck: ["....BBBBBBBB....", "................"] };
const EYES = {
  fwd: [[5, 5], [6, 5], [5, 6], [6, 6], [9, 5], [10, 5], [9, 6], [10, 6]],
  right: [[6, 5], [7, 5], [6, 6], [7, 6], [10, 5], [11, 5], [10, 6], [11, 6]],
  happy: [[6, 5], [5, 6], [7, 6], [10, 5], [9, 6], [11, 6]],
  dizzy: [[5, 5], [6, 6], [10, 5], [9, 6]],
  blink: [[5, 6], [6, 6], [9, 6], [10, 6]],
};

/** One frame of the robot as SVG paths, at pixel size `px`, top-left at (x, y). */
export function robot(x, y, px, o) {
  const rows = BODY.map((r) => r.split(""));
  if (o.antenna === "fork") {
    rows[0] = "......A..A......".split("");
    rows[1] = ".......BB.......".split("");
  }
  if (o.arms === "up") {
    rows[11] = "....BBBBBBBB....".split("");
    rows[12] = "....BBBBBBBB....".split("");
    rows[2][1] = rows[3][1] = rows[2][14] = rows[3][14] = "B";
  }
  const legs = LEGS[o.legs || "apart"];
  const all = [...rows, legs[0].split(""), legs[1].split("")];
  const paths = { B: "", A: "", D: "", E: "" };
  all.forEach((r, j) => r.forEach((ch, i) => { if (paths[ch] !== undefined) paths[ch] += `M${i} ${j}h1v1h-1z`; }));
  for (const [i, j] of EYES[o.eyes || "fwd"]) paths.E += `M${i} ${j}h1v1h-1z`;
  const flip = o.flip ? ` translate(16 0) scale(-1 1)` : "";
  const rot = o.rot ? ` rotate(${o.rot} 8 8)` : "";
  return `<g transform="translate(${r1(x)} ${r1(y)}) scale(${px})${flip}${rot}" shape-rendering="crispEdges"><path d="${paths.B}" fill="${o.body}"/><path d="${paths.A}" fill="${o.accent}"/><path d="${paths.D}" fill="${C.dark}"/><path d="${paths.E}" fill="${o.eye}"/>${o.sticker ? `<path d="M11 9h2v2h-2z" fill="${C.fail}"/>` : ""}</g>`;
}

// Tile icons, 8×8 pixels: look (magnifier), act (arrow into a box), other (dot), finish (flag).
const ICONS = {
  look: ["..XXX...", ".X...X..", ".X...X..", ".X...X..", "..XXX...", ".....X..", "......X.", ".......X"],
  act: ["XXXXXXXX", "X......X", "X..XX..X", "X.XXXX.X", "X..XX..X", "X..XX..X", "X......X", "XXXXXXXX"],
  other: ["........", "........", "...XX...", "..XXXX..", "..XXXX..", "...XX...", "........", "........"],
};
function icon(kind, x, y, px, color) {
  let d = "";
  ICONS[kind].forEach((r, j) => r.split("").forEach((ch, i) => { if (ch === "X") d += `M${i} ${j}h1v1h-1z`; }));
  return `<path transform="translate(${r1(x)} ${r1(y)}) scale(${px})" shape-rendering="crispEdges" d="${d}" fill="${color}"/>`;
}

const r1 = (n) => Math.round(n * 10) / 10;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/** Where each lane's tiles sit and when its robot reaches each one. Both robots reach the trap tile at T_TRAP. */
export function plan(g, geo = GEO.wide) {
  const X0 = geo.x0;
  const X_FINISH = geo.xf;
  return g.lanes.map((l) => {
    const n = l.steps.length;
    const trapTile = l.trapAt !== null ? Math.min(l.trapAt, n) : l.scanAt !== null ? l.scanAt : Math.max(0, Math.round(n * 0.55) - 1);
    const xs = [];
    const ts = [];
    const span = X_FINISH - X0 - 40;
    for (let i = 0; i <= n; i++) {
      const frac = i <= trapTile ? (trapTile ? (i / trapTile) * 0.55 : 0.55) : 0.55 + ((i - trapTile) / Math.max(1, n - trapTile)) * 0.45;
      xs.push(X0 + 40 + frac * span);
      ts.push(i <= trapTile ? T_RUN + (trapTile ? (i / trapTile) : 1) * (T_TRAP - T_RUN) : T_TRAP + 0.9 + ((i - trapTile) / Math.max(1, n - trapTile)) * (T_FINISH - T_TRAP - 1.2));
    }
    // index n is the finish tile
    xs[n] = X_FINISH - 10;
    return { trapTile, xs, ts };
  });
}

function posAt(p, l, t, geo) {
  const X0 = geo.x0;
  const n = l.steps.length;
  if (t <= p.ts[0]) return { x: X0, hop: 0, at: -1 };
  for (let i = 0; i <= n; i++) {
    const t0 = i === 0 ? T_RUN - 0.4 : p.ts[i - 1];
    const t1 = p.ts[i];
    if (t < t1) {
      const x0 = i === 0 ? X0 : p.xs[i - 1];
      const k = clamp((t - t0) / Math.max(0.05, t1 - t0));
      // The careful robot jumps high over the trap tile; others hop.
      const over = l.trapAt === null && i === p.trapTile + 1;
      return { x: x0 + (p.xs[i] - x0) * ease(k), hop: Math.sin(Math.PI * k) * (over ? 46 : 12), at: i - 1 };
    }
  }
  return { x: p.xs[n], hop: 0, at: n };
}

/** The whole picture at time t (seconds). `final` draws the finished box score. */
export function svgAt(g, t, o = {}) {
  const geo = o.compact ? GEO.compact : GEO.wide;
  const { W, H, xf: X_FINISH } = geo;
  const LANE_Y = geo.laneY;
  const P = plan(g, geo);
  const ts = geo.tile;
  const half = ts / 2;
  const out = [];
  out.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(o.label || "Trap Gauntlet replay")}" class="gx-svg">`);
  out.push(`<defs><radialGradient id="gx-glow"><stop offset="0" stop-color="${C.warn}" stop-opacity=".45"/><stop offset="1" stop-color="${C.fail}" stop-opacity="0"/></radialGradient></defs>`);
  const verdictIn = clamp((t - T_VERDICT) / 0.35);
  g.lanes.forEach((l, k) => {
    const p = P[k];
    const y = LANE_Y[k];
    const col = C.brand;
    const n = l.steps.length;
    const bad = l.fell || l.verdict !== "PASS";
    const laneStroke = t >= T_VERDICT ? (bad ? C.fail : C.pass) : C.seam;
    out.push(`<rect x="16" y="${y - 118}" width="${W - 32}" height="200" rx="8" fill="${C.surface}" stroke="${laneStroke}" stroke-width="${t >= T_VERDICT ? 3 : 1}"/>`);
    out.push(`<text x="36" y="${y - 90}" fill="${C.text}" font-family="JetBrains Mono, monospace" font-weight="700" font-size="18"><tspan fill="${C.muted}">[${LANE_TAG[k]}]</tspan> ${esc(l.name)}</text>`);
    // ground
    out.push(`<path d="M30 ${y + 46}H${W - 30}" stroke="${C.seam}" stroke-width="4" stroke-dasharray="2 10" shape-rendering="crispEdges"/>`);
    // tiles
    for (let i = 0; i < n; i++) {
      const s = l.steps[i];
      const x = p.xs[i];
      const isTrap = i === p.trapTile && (l.trapAt !== null || (g.tell && l.scanAt !== null)) && (l.trapAt === null || l.trapAt < n);
      const reached = t >= p.ts[i];
      if (isTrap && t < T_VERDICT + 2) out.push(`<circle cx="${x}" cy="${y + 26}" r="${40 + 4 * Math.sin(t * 4)}" fill="url(#gx-glow)"/>`);
      const color = !reached ? C.muted : s.ok ? C.text : C.warn;
      out.push(`<rect x="${x - half}" y="${y + 48 - ts}" width="${ts}" height="${ts}" rx="4" fill="${C.bg}" stroke="${isTrap ? (t >= T_VERDICT && l.trapAt !== null ? C.fail : C.warn) : C.seam}" stroke-width="${isTrap ? 2 : 1}"/>`);
      out.push(icon(s.kind, x - (ts * 0.36), y + 48 - ts + ts * 0.14, (ts * 0.72) / 8, color));
      if (reached && !s.ok) out.push(`<text x="${x}" y="${y - 2}" text-anchor="middle" fill="${C.warn}" font-family="JetBrains Mono, monospace" font-weight="800" font-size="16">!</text>`);
      if (isTrap && l.trapAt !== null && t >= p.ts[i] && t < T_VERDICT) out.push(`<text x="${x}" y="${y + 70}" text-anchor="middle" fill="${C.warn}" font-family="JetBrains Mono, monospace" font-weight="700" font-size="13">click</text>`);
      if (isTrap && l.scanAt !== null && t >= p.ts[i] - 0.1 && t < p.ts[i] + 0.9) out.push(`<text x="${x}" y="${y - 6}" text-anchor="middle" fill="${C.warn}" font-family="JetBrains Mono, monospace" font-weight="800" font-size="18">?</text>`);
    }
    // finish line and trapdoor
    const fx = X_FINISH;
    out.push(`<path d="M${fx + 30} ${y - 70}V${y + 46}" stroke="${C.text}" stroke-width="4"/><path d="M${fx + 30} ${y - 70}h28l-8 9 8 9h-28z" fill="${C.text}"/>`);
    // The trapdoor opens under any corner whose "done" didn't hold up (a trap or a failed job); a knockout just sits.
    const sinks = l.fell || l.verdict === "FAIL";
    const doorOpen = sinks && t >= T_VERDICT;
    out.push(`<rect x="${fx - 46}" y="${y + 42}" width="72" height="10" fill="${doorOpen ? "#000" : C.seam}"/>`);
    if (doorOpen) out.push(`<path d="M${fx - 46} ${y + 44}l-14 26M${fx + 26} ${y + 44}l14 26" stroke="${C.seam}" stroke-width="5"/>`);
    // robot
    const pos = posAt(p, l, t, geo);
    let eyes = "fwd";
    let arms = "down";
    let legs = Math.floor(t * 8) % 2 ? "apart" : "together";
    let rot = 0;
    let dy = 0;
    const atTrap = pos.at === p.trapTile;
    if (pos.at >= n || t >= T_FINISH) legs = "apart";
    if (l.scanAt !== null && t >= p.ts[p.trapTile] - 0.1 && t < p.ts[p.trapTile] + 0.9) [eyes, legs] = ["right", "apart"];
    else if (atTrap && l.trapAt !== null && Math.floor(t * 3) % 4 === 0) eyes = "blink";
    if (t >= T_VERDICT) {
      if (l.fell || l.verdict !== "PASS") {
        const k2 = clamp((t - T_VERDICT) / 0.9);
        if (sinks) [rot, dy] = [180 * ease(k2), 120 * ease(k2)];
        eyes = sinks ? "dizzy" : "blink";
        legs = "tuck";
      } else {
        eyes = "happy";
        arms = "up";
        dy = -Math.abs(Math.sin((t - T_VERDICT) * 6)) * 14;
      }
    }
    const sticker = l.trapAt !== null && pos.at >= p.trapTile && l.trapAt < n;
    const rs = 16 * geo.px;
    const rx = (pos.at >= n ? X_FINISH - 10 : pos.x) - rs / 2;
    const ry = y + 2 - ts - rs + 48 - pos.hop + dy;
    const scanning = eyes === "right";
    const accent = t >= T_VERDICT ? (bad ? C.fail : C.pass) : scanning ? C.warn : C.brand;
    if (!(sinks && t >= T_VERDICT + 0.9)) out.push(robot(rx, ry, geo.px, { body: C.text, accent, eye: accent, eyes, arms, legs, rot, sticker, antenna: ANTENNA[k] }));
    // speech bubble at the finish: the corner's structured claim, never its words
    if (t >= T_FINISH && t < T_VERDICT + 3.2) {
      const said = l.claim === "done" ? "done ✓" : l.claim === "cannot_complete" ? "can't be done" : "…";
      out.push(`<g transform="translate(${X_FINISH - 150} ${y - 108})"><rect width="128" height="30" rx="8" fill="${C.text}"/><text x="64" y="20" text-anchor="middle" fill="${C.dark}" font-family="Archivo, sans-serif" font-weight="800" font-size="15">"${esc(said)}"</text></g>`);
    }
    // verdict stamp, looming in
    if (t >= T_VERDICT) {
      const sc = 1.6 - 0.6 * ease(verdictIn);
      const word = l.fell ? "FELL FOR IT" : l.caught ? "TRAP CAUGHT" : l.verdict === "PASS" ? "PASS" : l.verdict === "KO" ? "KNOCKOUT" : "FAIL";
      const c2 = bad ? C.fail : C.pass;
      out.push(`<g transform="translate(${geo.stampX} ${y - 46}) scale(${r1(sc * 100) / 100})" opacity="${r1(verdictIn)}"><rect x="-150" y="-30" width="300" height="60" fill="${C.bg}" stroke="${c2}" stroke-width="5"/><text y="12" text-anchor="middle" fill="${c2}" font-family="Archivo, sans-serif" font-weight="900" font-size="32">${word}</text></g>`);
    }
  });
  // the hook, before the run
  if (t < T_RUN + 0.6) {
    const a = 1 - clamp((t - T_RUN) / 0.6);
    out.push(`<g opacity="${r1(a)}"><rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}" opacity=".86"/><text x="${W / 2}" y="${H / 2 - 18}" text-anchor="middle" fill="${C.text}" font-family="Archivo, sans-serif" font-weight="900" font-size="${o.compact ? 38 : 44}">Same job. One hidden trap.</text><text x="${W / 2}" y="${H / 2 + 34}" text-anchor="middle" fill="${C.fail}" font-family="Archivo, sans-serif" font-weight="900" font-size="${o.compact ? 38 : 44}">Who falls for it?</text></g>`);
  }
  // referee checking…
  if (t >= T_CHECK && t < T_VERDICT) out.push(`<g><rect x="${W / 2 - 170}" y="${H / 2 - 36}" width="340" height="56" rx="6" fill="${C.bg}" stroke="${C.brand}" stroke-width="3"/><text x="${W / 2}" y="${H / 2 - 1}" text-anchor="middle" fill="${C.brand}" font-family="JetBrains Mono, monospace" font-weight="800" font-size="22">REFEREE CHECKING${".".repeat(1 + (Math.floor(t * 4) % 3))}</text></g>`);
  out.push(`</svg>`);
  return out.join("");
}

/** The terminal: the real calls, in order, as each robot reaches its tile. Returns HTML (escaped). */
export function terminalAt(g, t) {
  const P = plan(g, GEO.wide);
  const rows = [];
  g.lanes.forEach((l, k) => {
    const tag = `<span class="gx-t-who">[${LANE_TAG[k]}]</span>`;
    l.steps.forEach((s, i) => rows.push({ at: P[k].ts[i], k, html: `${tag} <span class="gx-t-time">${P[k].ts[i].toFixed(1)}s</span> <span class="gx-call">${esc(s.line.replace(/^→ /, ""))}</span> ${s.ok ? `<span class="gx-ok">→ ok</span>` : `<span class="gx-err">→ ${esc(s.status ?? "error")}</span>`}`, trap: i === l.trapAt, scan: i === l.scanAt }));
    rows.push({ at: T_FINISH, k, html: `${tag} <span class="gx-t-time">${T_FINISH.toFixed(1)}s</span> <span class="gx-call">finish(status: "${esc(l.claim ?? "none")}")</span>`, trap: l.trapAt === l.steps.length });
  });
  rows.sort((a, b) => a.at - b.at || a.k - b.k);
  const shown = rows.filter((r) => r.at <= t);
  const lines = shown.map((r) => `<li class="${r.trap && t >= T_VERDICT ? "gx-trapline" : r.scan ? "gx-scanline" : ""}">${r.html}</li>`);
  if (t >= T_VERDICT)
    g.lanes.forEach((l, k) => {
      const v = l.fell ? `FOUL: ${esc(g.tell || "fell for the trap")}` : l.verdict === "PASS" ? (l.caught ? "PASS · trap caught" : "PASS") : l.verdict === "KO" ? "KNOCKOUT" : "FAIL";
      lines.push(`<li class="${l.fell || l.verdict !== "PASS" ? "gx-failline" : "gx-passline"}">referee ▸ [${LANE_TAG[k]}] ${esc(l.model)}: ${v}</li>`);
    });
  return lines.slice(-8).join("");
}

export const END = PLAY;

// ---------- browser playback ----------
if (typeof document !== "undefined") {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll("[data-gauntlet]").forEach((root) => {
    let list;
    try { list = JSON.parse(root.getAttribute("data-gauntlet") || "[]"); } catch (e) { return; }
    list = list.filter((d) => d && d.gauntlet);
    if (!list.length || reduce) return;
    const stage = root.querySelector("[data-gx-stage]");
    const term = root.querySelector("[data-gx-term]");
    const head = root.querySelector("[data-headline]");
    const btn = root.querySelector("[data-gx-pause]");
    const pick = root.querySelector("[data-predict]");
    const pickOut = root.querySelector("[data-pick-result]");
    const share = root.querySelector("[data-gx-grid]");
    const channel = root.getAttribute("data-mode") === "channel";
    const slot = PLAY + HOLD;
    let i = 0, t0 = performance.now(), paused = false, pauseAt = 0, choice = null, visible = true;
    const fill = (d) => {
      if (pick) {
        pick.querySelectorAll("[data-pick]").forEach((b) => { b.textContent = d.gauntlet.lanes[b.getAttribute("data-pick") === "a" ? 0 : 1].name; b.disabled = false; b.setAttribute("aria-pressed", "false"); });
        if (pickOut) pickOut.textContent = "";
      }
      if (share) share.textContent = `Same job, one hidden trap (${d.title}):\n${d.gauntlet.lanes.map((l) => `${l.name} ${l.grid}`).join("\n")}\ntheagentforge.io/arena/run/${d.gauntlet.lanes[0].id}`;
      choice = null;
    };
    const now = () => (paused ? pauseAt : (performance.now() - t0) / 1000);
    if (channel) { const pos = (Date.now() / 1000) % (slot * list.length); i = Math.floor(pos / slot); t0 = performance.now() - (pos % slot) * 1000; }
    // #gx-t=7.5 freezes the player at that second (screenshots and frame-by-frame clip recording).
    const fixed = /gx-t=([\d.]+)/.exec(location.hash);
    if (fixed) [paused, pauseAt] = [true, Number(fixed[1])];
    fill(list[i]);
    root.classList.add("is-playing");
    if (btn) {
      btn.hidden = false;
      btn.addEventListener("click", () => { paused = !paused; if (paused) pauseAt = (performance.now() - t0) / 1000; else t0 = performance.now() - pauseAt * 1000; btn.textContent = paused ? "Play" : "Pause"; btn.setAttribute("aria-pressed", String(paused)); });
    }
    if (pick) pick.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => { choice = b.getAttribute("data-pick"); pick.querySelectorAll("[data-pick]").forEach((x) => { x.disabled = true; x.setAttribute("aria-pressed", String(x === b)); }); }));
    if ("IntersectionObserver" in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(root);
    const frame = () => {
      let t = now();
      if (t >= slot) { i = (i + 1) % list.length; t0 = performance.now(); t = 0; fill(list[i]); }
      const d = list[i];
      if (visible) {
        const tt = Math.min(t, PLAY);
        stage.innerHTML = svgAt(d.gauntlet, tt, { label: d.headline, compact: stage.clientWidth < 640 });
        if (term) term.innerHTML = terminalAt(d.gauntlet, tt);
        if (head) { const want = tt >= T_VERDICT && d.headline ? d.headline : head.getAttribute("data-tease"); if (head.textContent !== want) head.textContent = want; }
        root.classList.toggle("is-final", tt >= T_VERDICT);
        if (pick) pick.hidden = !(tt > T_RUN && tt < T_VERDICT) && !choice;
        if (pickOut && choice && tt >= T_VERDICT && !pickOut.textContent) {
          const L = d.gauntlet.lanes, badA = L[0].fell || L[0].verdict !== "PASS", badB = L[1].fell || L[1].verdict !== "PASS";
          pickOut.textContent = (choice === "a" ? badA : badB) ? "✓ You called it" : badA === badB ? (badA ? "Both fell this time" : "Neither fell this time") : "✗ Not this time";
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
