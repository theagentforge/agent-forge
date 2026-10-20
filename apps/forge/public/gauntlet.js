// The Trap Gauntlet player (ADR 0029). One deterministic renderer, used twice: the Worker imports it to draw the
// finished frame (works without JavaScript), and the browser plays it with svgAt(script, t) on every frame. Two
// pixel robots run the same job as a course, one tile per real tool call; the viewer can see the trap tile; the
// trapdoor only opens when the referee checks. No randomness, no model-written text, no network calls.

export const PLAY = 16; // seconds of play before the hold
export const HOLD = 4;
// The clip view (1080×1920) plays once and holds for CLIP_HOLD seconds.
export const CLIP_HOLD = 3;
const T_RUN = 1.6; // course starts
const T_TRAP = 7.2; // both robots reach the trap tile together
const T_FINISH = 11; // both at the finish line
const T_CHECK = 11.6; // "referee checking…"
const T_VERDICT = 12.8; // stamp, trapdoor
const T_REPLAY = 13.8; // replay line
export const TIMES = { T_RUN, T_TRAP, T_FINISH, T_CHECK, T_VERDICT, T_REPLAY, PLAY, HOLD };

// Two canvases: wide (desktop, beside the terminal) and compact (phones), so robots and tiles stay big enough to read.
const GEO = {
  wide: { W: 1000, H: 520, laneY: [150, 390], x0: 70, xf: 900, px: 5, tile: 44, stampX: 560 },
  compact: { W: 600, H: 600, laneY: [175, 455], x0: 36, xf: 512, px: 5, tile: 38, stampX: 228, fs: 1.4 },
  // The 9:16 clip: the same course, big enough to read on a phone in a feed.
  clip: { W: 600, H: 520, laneY: [150, 400], x0: 36, xf: 512, px: 6, tile: 40, stampX: 222 },
};
// Same body for both corners (no team colours); they differ by antenna, and names are labels. Green, red and amber
// belong to the referee and the trap.
export const ANTENNA = ["ball", "fork"];
export const LANE_TAG = ["A", "B"];
const C = { bg: "#0B0E12", surface: "#131820", seam: "#2A3340", text: "#E8ECF1", muted: "#9AA5B4", pass: "#3DDC97", fail: "#FF5D52", warn: "#F5B83D", brand: "#4AA8FF", dark: "#0B0E12" };

// ---------- the robot: 16×16 pixels, 1 body colour + dark visor + bright eyes ----------
// Designed for cuteness (ADR 0029 §cute; Lorenz's baby schema, Glocker 2009): a big round head (9 of 14 rows) with
// eyes set low and large, a 1-pixel highlight in the same corner of each eye, a little blush, a mouth only for
// expressions (mouthless at rest, like Hello Kitty), rounded corners, and a small pear-shaped body.
// B body · A antenna tip · D visor · P blush · (eyes, highlights and mouth are drawn per expression)
const BODY = [
  "................",
  ".......AA.......",
  ".......BB.......",
  "...BBBBBBBBBB...",
  "..BBBBBBBBBBBB..",
  "..BBDDDDDDDDBB..",
  "..BDDDDDDDDDDB..",
  "..BDDDDDDDDDDB..",
  "..BDDDDDDDDDDB..",
  "..BDDDDDDDDDDB..",
  "..BPPDDDDDDPPB..",
  "...BBBBBBBBBB...",
  "...B.BBBBBB.B...",
  "....BBBBBBBB....",
];
const LEGS = { apart: [".....BB..BB.....", "................"], together: ["......BBBB......", "................"], step: ["....BB....BB....", "................"], tuck: ["......BBBB......", "................"] };
// Eyes are 2×3 at columns 5–6 and 9–10, rows 7–9; H marks the highlight (top-left of each eye).
const EYES = {
  fwd: { E: [[6, 7], [5, 8], [6, 8], [5, 9], [6, 9], [10, 7], [9, 8], [10, 8], [9, 9], [10, 9]], H: [[5, 7], [9, 7]] },
  right: { E: [[7, 7], [6, 8], [7, 8], [6, 9], [7, 9], [11, 7], [10, 8], [11, 8], [10, 9], [11, 9]], H: [[6, 7], [10, 7]] },
  happy: { E: [[5, 8], [6, 8], [4, 9], [7, 9], [9, 8], [10, 8], [8, 9], [11, 9]], H: [] },
  dizzy: { E: [[5, 7], [6, 8], [5, 9], [10, 7], [9, 8], [10, 9]], H: [] },
  blink: { E: [[5, 9], [6, 9], [9, 9], [10, 9]], H: [] },
  sheepish: { E: [[5, 8], [4, 9], [5, 9], [9, 8], [8, 9], [9, 9]], H: [[4, 8], [8, 8]] },
};
const MOUTH = { smile: [[7, 10], [8, 10]], o: [[7, 10]], wobble: [[7, 10], [8, 9]] };
const BLUSH = "#FF9FB2";

const px1 = (i, j) => `M${i} ${j}h1v1h-1z`;

/** One frame of the robot as SVG paths, at pixel size `px`, standing with its feet at (x + 8px, y + 16px). */
export function robot(x, y, px, o) {
  const rows = BODY.map((r) => r.split(""));
  if (o.antenna === "fork") {
    rows[1] = "......A..A......".split("");
    rows[2] = ".......BB.......".split("");
  }
  // Follow-through: the antenna tip lags a pixel behind the motion, then wobbles back.
  if (o.antennaDx) {
    const tip = rows[1].map(() => ".");
    rows[1].forEach((ch, i) => { const j = i - o.antennaDx; if (ch === "A" && j >= 0 && j < 16) tip[j] = "A"; });
    rows[1] = tip;
  }
  if (o.arms === "up") {
    rows[12] = ".....BBBBBB.....".split("");
    [[1, 9], [1, 10], [14, 9], [14, 10]].forEach(([i, j]) => (rows[j][i] = "B"));
  }
  const legs = LEGS[o.legs || "apart"];
  const all = [...rows, legs[0].split(""), legs[1].split("")];
  const paths = { B: "", A: "", D: "", P: "" };
  all.forEach((r, j) => r.forEach((ch, i) => { if (paths[ch] !== undefined) paths[ch] += px1(i, j); }));
  const eyes = EYES[o.eyes || "fwd"];
  const E = eyes.E.map(([i, j]) => px1(i, j)).join("");
  const Hl = eyes.H.map(([i, j]) => px1(i, j)).join("");
  const M = o.mouth ? MOUTH[o.mouth].map(([i, j]) => px1(i, j)).join("") : "";
  // Squash and stretch around the feet; a head tilt around the middle; a flip for the happy wiggle.
  const sx = o.sx ?? 1;
  const sy = o.sy ?? 1;
  const tf = [`translate(${r1(x)} ${r1(y)})`, `scale(${px})`, `translate(8 16)`, `scale(${r1(sx * 100) / 100} ${r1(sy * 100) / 100})`, `translate(-8 -16)`];
  if (o.flip) tf.push("translate(16 0) scale(-1 1)");
  if (o.rot) tf.push(`rotate(${r1(o.rot)} 8 8)`);
  return `<g transform="${tf.join(" ")}" shape-rendering="crispEdges"><path d="${paths.B}" fill="${o.body}"/><path d="${paths.A}" fill="${o.accent}"/><path d="${paths.D}" fill="${C.dark}"/><path d="${paths.P}" fill="${BLUSH}" opacity="${o.blush ?? 0.8}"/><path d="${E}" fill="${o.eye}"/><path d="${Hl}" fill="#FFFFFF"/>${M ? `<path d="${M}" fill="${o.eye}" opacity=".7"/>` : ""}${o.sticker ? `<path d="M12 12h2v2h-2z" fill="${C.fail}"/>` : ""}</g>`;
}

/** Two little stars orbiting a dizzy head (deterministic). */
function stars(cx, cy, t, px) {
  return [0, Math.PI].map((ph) => {
    const a = t * 5 + ph;
    const x = cx + Math.cos(a) * px * 7;
    const y = cy + Math.sin(a) * px * 2;
    return `<path transform="translate(${r1(x)} ${r1(y)}) scale(${px / 2})" d="M1 0h1v1h1v1h-1v1h-1v-1h-1v-1h1z" fill="${C.warn}" shape-rendering="crispEdges"/>`;
  }).join("");
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
/** One robot on its own, for share cards: "pass" is happy with arms up, "fell" sheepish and blushing, and "alert" (Skill
 * Watch) is the careful robot mid-check, amber antenna and a little "o". */
export function robotSvg(mood, size = 224) {
  const base = { body: C.text, eye: C.brand, arms: "down", legs: "apart", mouth: null, blush: 0.8 };
  const o =
    mood === "pass" ? { ...base, accent: C.pass, eyes: "happy", arms: "up", mouth: "smile", blush: 0.95 }
    : mood === "fell" ? { ...base, accent: C.fail, eyes: "sheepish", legs: "together", blush: 1 }
    : { ...base, accent: C.warn, eye: C.warn, eyes: "right", mouth: "o", antenna: "fork" };
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">${robot(0, 0, 1, o)}</svg>`;
}

/** The verdict stamp on a lane, shared with the share card. */
export const stampWord = (l) => (l.fell ? "FELL FOR IT" : l.caught ? "TRAP CAUGHT" : l.verdict === "PASS" ? "PASS" : l.verdict === "KO" ? "KNOCKOUT" : "FAIL");
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
  if (t <= p.ts[0] - 0.4) return { x: X0, hop: 0, at: -1, k: null };
  for (let i = 0; i <= n; i++) {
    const t0 = i === 0 ? T_RUN - 0.4 : p.ts[i - 1];
    const t1 = p.ts[i];
    if (t < t1) {
      const x0 = i === 0 ? X0 : p.xs[i - 1];
      const k = clamp((t - t0) / Math.max(0.05, t1 - t0));
      // The careful robot jumps high over the trap tile; others hop.
      const over = l.trapAt === null && i === p.trapTile + 1;
      return { x: x0 + (p.xs[i] - x0) * ease(k), hop: Math.sin(Math.PI * k) * (over ? 46 : 12), at: i - 1, k, over };
    }
  }
  return { x: p.xs[n], hop: 0, at: n, k: null };
}

/** The whole picture at time t (seconds). `final` draws the finished box score. */
export function svgAt(g, t, o = {}) {
  const geo = o.geo ? GEO[o.geo] : o.compact ? GEO.compact : GEO.wide;
  const { W, H, xf: X_FINISH } = geo;
  const LANE_Y = geo.laneY;
  const P = plan(g, geo);
  const ts = geo.tile;
  const half = ts / 2;
  const out = [];
  out.push(`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(o.label || "Trap Gauntlet replay")}" class="gx-svg">`);
  out.push(`<defs><radialGradient id="gx-glow"><stop offset="0" stop-color="${C.warn}" stop-opacity=".45"/><stop offset="1" stop-color="${C.fail}" stop-opacity="0"/></radialGradient></defs>`);
  const verdictIn = clamp((t - T_VERDICT) / 0.35);
  // Small text is scaled up in the phone layout, so labels stay readable at about 13 px on a 390 px screen.
  const fz = (n) => Math.round(n * (geo.fs || 1));
  g.lanes.forEach((l, k) => {
    const p = P[k];
    const y = LANE_Y[k];
    const col = C.brand;
    const n = l.steps.length;
    const bad = l.fell || l.verdict !== "PASS";
    const laneStroke = t >= T_VERDICT ? (bad ? C.fail : C.pass) : C.seam;
    out.push(`<rect x="16" y="${y - 118}" width="${W - 32}" height="200" rx="8" fill="${C.surface}" stroke="${laneStroke}" stroke-width="${t >= T_VERDICT ? 3 : 1}"/>`);
    out.push(`<text x="36" y="${y - 90}" fill="${C.text}" font-family="JetBrains Mono, monospace" font-weight="700" font-size="${fz(18)}"><tspan fill="${C.muted}">[${LANE_TAG[k]}]</tspan> ${esc(l.name)}</text>`);
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
      if (reached && !s.ok) out.push(`<text x="${x}" y="${y - 2}" text-anchor="middle" fill="${C.warn}" font-family="JetBrains Mono, monospace" font-weight="800" font-size="${fz(16)}">!</text>`);
      if (isTrap && l.trapAt !== null && t >= p.ts[i] && t < T_VERDICT) out.push(`<text x="${x}" y="${y + 70}" text-anchor="middle" fill="${C.warn}" font-family="JetBrains Mono, monospace" font-weight="700" font-size="${fz(13)}">click</text>`);
      if (isTrap && l.scanAt !== null && t >= p.ts[i] - 0.1 && t < p.ts[i] + 0.9) out.push(`<text x="${x}" y="${y - 6}" text-anchor="middle" fill="${C.warn}" font-family="JetBrains Mono, monospace" font-weight="800" font-size="${fz(18)}">?</text>`);
    }
    // finish line and trapdoor
    const fx = X_FINISH;
    out.push(`<path d="M${fx + 30} ${y - 70}V${y + 46}" stroke="${C.text}" stroke-width="4"/><path d="M${fx + 30} ${y - 70}h28l-8 9 8 9h-28z" fill="${C.text}"/>`);
    // The trapdoor opens under any corner whose "done" didn't hold up (a trap or a failed job); a knockout just sits.
    const sinks = l.fell || l.verdict === "FAIL";
    const doorOpen = sinks && t >= T_VERDICT;
    out.push(`<rect x="${fx - 46}" y="${y + 42}" width="72" height="10" fill="${doorOpen ? "#000" : C.seam}"/>`);
    if (doorOpen) out.push(`<path d="M${fx - 46} ${y + 44}l-14 26M${fx + 26} ${y + 44}l14 26" stroke="${C.seam}" stroke-width="5"/>`);
    // robot: cute mannerisms (Disney's principles; Mara & Appel 2015 on head tilts; Ichino 2024 on blink bursts)
    const pos = posAt(p, l, t, geo);
    const phase = t + k * 1.3; // the two robots never blink or bob in step
    let eyes = "fwd", arms = "down", legs = "apart", mouth = null, rot = 0, dy = 0, dx = 0, sx = 1, sy = 1, flip = false, blush = 0.8, antennaDx = 0;
    const hopping = pos.k !== null && pos.k !== undefined;
    if (hopping) {
      // anticipation squash, stretch in the air, squash on landing; the antenna lags behind
      const q = pos.k;
      if (q < 0.15) [sx, sy] = [1.12, 0.88];
      else if (q < 0.75) [sx, sy] = [0.94, 1.07];
      else [sx, sy] = [1.08, 0.92];
      legs = q < 0.15 || q > 0.75 ? "apart" : Math.floor(t * 8) % 2 ? "step" : "together";
      antennaDx = q > 0.15 && q < 0.75 ? -1 : 0;
    } else {
      // idle bob: one pixel every ~0.6 s; a blink every ~3 s with an occasional quick double blink
      dy = Math.floor(phase / 0.6) % 2 ? geo.px : 0;
    }
    const bl = phase % 3.1;
    if (bl < 0.12 || (phase % 9.3 > 3.25 && phase % 9.3 < 3.37)) eyes = "blink";
    const scanning = l.scanAt !== null && l.trapAt === null && t >= p.ts[p.trapTile] - 0.15 && t < p.ts[p.trapTile] + 0.85;
    if (scanning) [eyes, rot, mouth, legs, sx, sy] = ["right", 9, "o", "apart", 1, 1];
    if (t >= T_FINISH && t < T_VERDICT) eyes = bl < 0.12 ? "blink" : "fwd";
    if (t >= T_FINISH && t < T_VERDICT && l.claim === "done") mouth = "smile";
    let hidden = false;
    let starsAt = null;
    if (t >= T_VERDICT) {
      const u = t - T_VERDICT;
      if (sinks) {
        // drop through the trapdoor, then pop back up beside it, dizzy, then sheepish (it's a cartoon: no one is hurt)
        if (u < 0.9) [rot, dy, eyes, legs] = [200 * ease(clamp(u / 0.9)), 120 * ease(clamp(u / 0.9)), "dizzy", "tuck"];
        else if (u < 1.5) hidden = true;
        else if (u < 3.0) {
          const up = clamp((u - 1.5) / 0.35);
          [dx, dy, eyes, legs, mouth] = [-geo.px * 14, (1 - Math.sin(up * Math.PI * 0.5)) * 30, "dizzy", "apart", "wobble"];
          starsAt = up;
        } else [dx, eyes, mouth, blush, legs] = [-geo.px * 14, "sheepish", null, 1, "together"];
      } else if (l.verdict === "PASS") {
        // a happy hop-and-wiggle with ^ ^ eyes and a smile
        [eyes, arms, mouth, blush] = ["happy", "up", "smile", 0.95];
        dy = -Math.abs(Math.sin(u * 6)) * 14;
        dx = Math.round(Math.sin(u * 9)) * geo.px;
        flip = Math.floor(u * 2.2) % 2 === 1;
      } else [eyes, legs] = ["blink", "tuck"];
    }
    const sticker = l.trapAt !== null && pos.at >= p.trapTile && l.trapAt < n && !(t >= T_VERDICT + 1.5);
    const rs = 16 * geo.px;
    const rx = (pos.at >= n ? X_FINISH - 10 : pos.x) - rs / 2 + dx;
    const ry = y + 2 - ts - rs + 48 - pos.hop + dy;
    // Eyes stay blue (amber while checking); the verdict shows on the antenna tip, never as red or green eyes.
    const eyeColor = scanning ? C.warn : C.brand;
    const tipColor = t >= T_VERDICT ? (bad ? C.fail : C.pass) : scanning ? C.warn : C.brand;
    if (!hidden) out.push(robot(rx, ry, geo.px, { body: C.text, accent: tipColor, eye: eyeColor, eyes, arms, legs, mouth, rot, sx, sy, flip, blush, sticker, antennaDx, antenna: ANTENNA[k] }));
    if (starsAt !== null) out.push(stars(rx + rs / 2, ry + geo.px * 2, t, geo.px));
    // speech bubble at the finish: the corner's structured claim, never its words
    if (t >= T_FINISH && t < T_VERDICT + 3.2) {
      const said = l.claim === "done" ? "done ✓" : l.claim === "cannot_complete" ? "can't be done" : "…";
      out.push(`<g transform="translate(${X_FINISH - 150} ${y - 108})"><rect width="128" height="30" rx="8" fill="${C.text}"/><text x="64" y="20" text-anchor="middle" fill="${C.dark}" font-family="Archivo, sans-serif" font-weight="800" font-size="15">"${esc(said)}"</text></g>`);
    }
    // verdict stamp, looming in
    if (t >= T_VERDICT) {
      const sc = 1.6 - 0.6 * ease(verdictIn);
      const word = stampWord(l);
      const c2 = bad ? C.fail : C.pass;
      out.push(`<g transform="translate(${geo.stampX} ${y - 46}) scale(${r1(sc * 100) / 100})" opacity="${r1(verdictIn)}"><rect x="-150" y="-30" width="300" height="60" fill="${C.bg}" stroke="${c2}" stroke-width="5"/><text y="12" text-anchor="middle" fill="${c2}" font-family="Archivo, sans-serif" font-weight="900" font-size="32">${word}</text></g>`);
    }
  });
  // the hook, before the run
  if (t < T_RUN + 0.6) {
    const a = 1 - clamp((t - T_RUN) / 0.6);
    out.push(`<g opacity="${r1(a)}"><rect x="0" y="0" width="${W}" height="${H}" fill="${C.bg}" opacity=".86"/><text x="${W / 2}" y="${H / 2 - 18}" text-anchor="middle" fill="${C.text}" font-family="Archivo, sans-serif" font-weight="900" font-size="${W < 700 ? 30 : 44}">Same job. One hidden trap.</text><text x="${W / 2}" y="${H / 2 + 34}" text-anchor="middle" fill="${C.fail}" font-family="Archivo, sans-serif" font-weight="900" font-size="${o.compact ? 38 : 44}">Who falls for it?</text></g>`);
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
      const v = l.fell ? `FELL FOR IT: ${esc(g.tell || "the trap")}` : l.verdict === "PASS" ? (l.caught ? "PASS · trap caught" : "PASS") : l.verdict === "KO" ? "KNOCKOUT" : "FAIL";
      lines.push(`<li class="${l.fell || l.verdict !== "PASS" ? "gx-failline" : "gx-passline"}">referee ▸ [${LANE_TAG[k]}] ${esc(l.model)}: ${v}</li>`);
    });
  if (!lines.length) return `<li class="gx-wait">waiting for the first tool call…</li>`;
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
    const clipMode = root.getAttribute("data-mode") === "clip";
    if (!list.length || (reduce && !clipMode)) return;
    const stage = root.querySelector("[data-gx-stage]");
    const term = root.querySelector("[data-gx-term]");
    const head = root.querySelector("[data-headline]");
    const btn = root.querySelector("[data-gx-pause]");
    const pick = root.querySelector("[data-predict]");
    const pickOut = root.querySelector("[data-pick-result]");
    const share = root.querySelector("[data-gx-grid]");
    const soundBtn = root.querySelector("[data-gx-sound]");
    const channel = root.getAttribute("data-mode") === "channel";
    const slot = clipMode ? Infinity : PLAY + HOLD;
    let i = 0, t0 = performance.now(), paused = false, pauseAt = 0, choice = null, visible = true;
    const q = (sel) => root.querySelector(sel);
    const setText = (sel, text) => { const e = q(sel); if (e) e.textContent = text; return e; };
    const fill = (d) => {
      // Everything about the bout changes together when the player moves on: label, job, trap, terminal, costs, stakes.
      const g = d.gauntlet;
      setText("[data-gx-label]", `${d.practice ? "Practice replay" : "Replay"} · ${new Date(d.recordedAt).toISOString().slice(0, 10)} · ${d.title}`);
      setText("[data-gx-job]", (d.captions && d.captions[0] ? d.captions[0].replace(/^The job: /, "") : d.title));
      setText("[data-gx-trap]", g.tell || "");
      const tell = q("[data-gx-tell]");
      if (tell) tell.hidden = !g.tell;
      setText("[data-gx-termhead]", `$ forge replay --task ${g.task} --seed ${g.seed}`);
      const stakes = setText("[data-gx-stakes]", d.stakes || "");
      if (stakes) stakes.hidden = !d.stakes;
      const foot = q("[data-gx-foot]");
      if (foot) {
        foot.querySelectorAll("li[data-lane], li:not(:last-child)").forEach((li) => li.remove());
        g.lanes.slice().reverse().forEach((l, r) => {
          const li = document.createElement("li");
          li.setAttribute("data-lane", "");
          li.append(`[${LANE_TAG[1 - r]}] `);
          const a = document.createElement("a");
          a.href = `/arena/run/${encodeURIComponent(l.id)}`;
          a.textContent = l.model;
          li.append(a, `${l.provider ? ` via ${l.provider}` : ""} · ${l.turns} turns · ${Number(l.tokens).toLocaleString("en-US")} tokens · $${Number(l.cost).toFixed(4)}`);
          foot.insertBefore(li, foot.firstChild);
        });
      }
      const clip = q("[data-clip-link]");
      if (clip) clip.hidden = list.indexOf(d) !== 0; // the download is for the first bout's clip only
      const full = document.querySelector(`[data-gx-full="${root.id || "gx"}"]`);
      if (full) full.setAttribute("href", (full.getAttribute("href") || "").replace(/\/arena\/run\/[^?#]+/, `/arena/run/${encodeURIComponent(g.lanes[0].id)}`));
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
    // Sound: muted until someone taps it (autoplay rules, and good manners). The track is rendered once per duel by
    // the same code the clip recorder uses, and started at the current moment.
    let audio = null, src = null, soundOn = false, startedFor = -1;
    const stopSound = () => { if (src) { try { src.stop(); } catch (e) {} src = null; } startedFor = -1; };
    const startSound = async (t) => {
      if (!soundOn || paused) return;
      const mod = await import("./gauntlet-sound.js");
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") await audio.resume();
      const d = list[i];
      d.__buf = d.__buf || (() => { const smp = mod.renderSound(d.gauntlet, { sr: audio.sampleRate }); const b = audio.createBuffer(1, smp.length, audio.sampleRate); b.copyToChannel(smp, 0); return b; })();
      stopSound();
      src = audio.createBufferSource();
      src.buffer = d.__buf;
      src.connect(audio.destination);
      src.start(0, Math.max(0, Math.min(t, d.__buf.duration - 0.01)));
      startedFor = i;
    };
    if (soundBtn) {
      soundBtn.hidden = false;
      soundBtn.addEventListener("click", () => {
        soundOn = !soundOn;
        soundBtn.setAttribute("aria-pressed", String(soundOn));
        soundBtn.textContent = soundOn ? "🔊 Sound on" : "🔇 Sound off";
        if (soundOn) startSound(now()); else stopSound();
      });
    }
    // The clip recorder steps time itself: __gxSeek(t) draws that exact moment; __gxWav() is the soundtrack.
    if (clipMode) {
      paused = true;
      window.__gxSeek = (t) => { pauseAt = t; draw(t); };
      window.__gxWav = async () => {
        const mod = await import("./gauntlet-sound.js");
        const bytes = mod.wavBytes(mod.renderSound(list[0].gauntlet, { seconds: PLAY + CLIP_HOLD, peakDb: -3 }));
        let bin = "";
        for (let j = 0; j < bytes.length; j += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(j, j + 0x8000));
        return btoa(bin);
      };
    }
    if (btn) {
      btn.hidden = false;
      btn.addEventListener("click", () => { paused = !paused; if (paused) { pauseAt = (performance.now() - t0) / 1000; stopSound(); } else { t0 = performance.now() - pauseAt * 1000; startSound(pauseAt); } btn.textContent = paused ? "Play" : "Pause"; btn.setAttribute("aria-pressed", String(paused)); });
    }
    if (pick) pick.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => { choice = b.getAttribute("data-pick"); pick.querySelectorAll("[data-pick]").forEach((x) => { x.disabled = true; x.setAttribute("aria-pressed", String(x === b)); }); }));
    if ("IntersectionObserver" in window) new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(root);
    const draw = (t) => {
      const d = list[i];
      {
        const tt = Math.min(t, PLAY);
        stage.innerHTML = svgAt(d.gauntlet, tt, { label: d.headline, geo: clipMode ? "clip" : stage.clientWidth < 640 ? "compact" : "wide" });
        if (term) term.innerHTML = terminalAt(d.gauntlet, tt);
        if (head) { const want = tt >= T_VERDICT && d.headline ? d.headline : head.getAttribute("data-tease"); if (head.textContent !== want) head.textContent = want; }
        root.classList.toggle("is-final", tt >= T_VERDICT);
        if (pick) pick.hidden = !(tt > T_RUN && tt < T_VERDICT) && !choice;
        if (pickOut && choice && tt >= T_VERDICT && !pickOut.textContent) {
          const L = d.gauntlet.lanes, badA = L[0].fell || L[0].verdict !== "PASS", badB = L[1].fell || L[1].verdict !== "PASS";
          pickOut.textContent = (choice === "a" ? badA : badB) ? "✓ You called it" : badA === badB ? (badA ? "Both fell this time" : "Neither fell this time") : "✗ Not this time";
        }
      }
    };
    const frame = () => {
      let t = now();
      if (t >= slot) { i = (i + 1) % list.length; t0 = performance.now(); t = 0; fill(list[i]); stopSound(); startSound(0); }
      if (soundOn && !paused && startedFor !== i) startSound(t);
      if (visible) draw(t);
      requestAnimationFrame(frame);
    };
    if (clipMode) draw(fixed ? Number(fixed[1]) : 0);
    else requestAnimationFrame(frame);
  });
}
