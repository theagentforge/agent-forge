// The Trap Gauntlet's sound (ADR 0029 §sound). Tiny, soft, synthesised tones (no sample files), timed from the same
// plan as the picture, so the web page and the MP4 clip sound identical. No randomness: variation comes only from
// the step index and the lane. Muted by default on the web; the clip recorder renders it to a WAV.
// Cute-sound research: high-ish and quiet reads as kawaii (Zhang et al. 2021; Ohkura ~2 kHz), rising = curious and
// friendly, falling = "uh-oh"; triangle/sine only, fundamentals under ~2.1 kHz, low-passed at 3.5 kHz.

import { plan, TIMES } from "./gauntlet.js";

export const SR = 48000;
const PENTA = [523, 587, 659, 784, 880];
const semis = (f, n) => f * Math.pow(2, n / 12);

/** Every sound in one duel, in seconds from the start of play. Lane B sits 3 semitones lower, in sine. */
export function soundEvents(g) {
  const P = plan(g);
  const ev = [];
  g.lanes.forEach((l, k) => {
    const p = P[k];
    const shift = k === 1 ? -3 : 0;
    const wave = k === 1 ? "sine" : "triangle";
    l.steps.forEach((_, i) => ev.push({ t: p.ts[i], kind: "step", i, shift, wave }));
    if (l.scanAt !== null && l.trapAt === null) ev.push({ t: p.ts[p.trapTile] - 0.1, kind: "scan", shift });
    if (l.trapAt !== null && l.trapAt < l.steps.length) ev.push({ t: p.ts[l.trapAt] + 0.05, kind: "uhoh", shift });
    const sinks = l.fell || l.verdict === "FAIL";
    if (sinks) {
      ev.push({ t: TIMES.T_VERDICT + 0.02, kind: "pop", shift });
      ev.push({ t: TIMES.T_VERDICT + 0.06, kind: "boing", shift });
      ev.push({ t: TIMES.T_VERDICT + 0.5, kind: "aww", shift });
    } else if (l.verdict === "PASS") {
      ev.push({ t: TIMES.T_VERDICT, kind: "tada", shift });
      ev.push({ t: TIMES.T_VERDICT + 0.75, kind: "celebrate", shift });
    }
  });
  ev.push({ t: TIMES.T_CHECK, kind: "checking", shift: 0 });
  return ev.sort((a, b) => a.t - b.t);
}

function tone(buf, sr, t0, o) {
  const start = Math.floor(t0 * sr);
  const n = Math.floor(o.dur * sr);
  const atk = Math.max(1, Math.floor((o.attack ?? 0.003) * sr));
  let phase = 0;
  for (let j = 0; j < n; j++) {
    const idx = start + j;
    if (idx < 0 || idx >= buf.length) continue;
    const u = j / n;
    let f = o.freq(u, j / sr);
    if (o.vib) f += Math.sin(2 * Math.PI * o.vib * (j / sr)) * (o.vibDepth ?? 10) * (o.vibFade ? 1 - u : 1);
    phase += f / sr;
    const ph = phase % 1;
    const s = o.wave === "triangle" ? 1 - 4 * Math.abs(ph - 0.5) : Math.sin(2 * Math.PI * ph);
    const env = j < atk ? j / atk : Math.pow(0.001, (j - atk) / Math.max(1, n - atk));
    buf[idx] += s * env * o.gain;
  }
}

const glide = (a, b, curve = 1) => (u) => a + (b - a) * Math.pow(u, curve);
const steps = (pairs) => (u) => { for (const [until, f] of pairs) if (u <= until) return f; return pairs[pairs.length - 1][1]; };

function play(buf, sr, e) {
  const sh = (f) => semis(f, e.shift);
  switch (e.kind) {
    case "step": {
      // A tiny hop "pip" that walks up a pentatonic scale, with a few cents of step-indexed detune.
      const N = sh(PENTA[e.i % 5]) * Math.pow(2, (((e.i % 3) - 1) * 15) / 1200);
      tone(buf, sr, e.t, { wave: e.wave, dur: 0.07, gain: 0.1, freq: (u) => (u < 0.57 ? 0.8 * N + 0.2 * N * (u / 0.57) : N) });
      break;
    }
    case "scan": // "hmm?": hold, then rise a fifth, with a little vibrato.
      tone(buf, sr, e.t, { wave: "sine", dur: 0.3, attack: 0.02, gain: 0.09, vib: 6, vibDepth: 12, freq: (u) => (u < 0.4 ? sh(494) : sh(494) + (sh(740) - sh(494)) * ((u - 0.4) / 0.6)) });
      break;
    case "uhoh": // a subtle falling minor third only the viewer notices
      tone(buf, sr, e.t, { wave: "sine", dur: 0.25, attack: 0.01, gain: 0.05, freq: steps([[0.36, sh(784)], [1, sh(659)]]) });
      break;
    case "checking": // soft ticks that speed up, then hang unresolved
      [440, 494, 523, 587, 659, 698].reduce((t, f, i) => {
        tone(buf, sr, t, { wave: "triangle", dur: 0.06, gain: 0.03 + i * 0.01, freq: () => f });
        return t + 0.06 + (0.2 - i * 0.018);
      }, e.t);
      tone(buf, sr, e.t + 1.0, { wave: "triangle", dur: 0.15, gain: 0.07, freq: () => 784 });
      break;
    case "tada":
      [523, 659, 784, 1047].forEach((f, i) => {
        const last = i === 3;
        tone(buf, sr, e.t + i * 0.07, { wave: "triangle", dur: last ? 0.32 : 0.08, attack: 0.005, gain: 0.11, vib: last ? 5 : 0, vibDepth: 6, freq: () => sh(f) });
        tone(buf, sr, e.t + i * 0.07, { wave: "sine", dur: last ? 0.32 : 0.08, attack: 0.005, gain: 0.033, freq: () => sh(f) * 2 });
      });
      break;
    case "aww": // sad but cute: a slow glide down that stays mid-high
      tone(buf, sr, e.t, { wave: "sine", dur: 0.45, attack: 0.03, gain: 0.09, vib: 5, vibDepth: 10, freq: glide(sh(698), sh(440), 0.8) });
      break;
    case "pop":
      tone(buf, sr, e.t, { wave: "sine", dur: 0.03, attack: 0.0015, gain: 0.12, freq: glide(1200, 300) });
      break;
    case "boing":
      tone(buf, sr, e.t, { wave: "sine", dur: 0.35, attack: 0.005, gain: 0.1, vib: 14, vibDepth: 60, vibFade: true, freq: glide(sh(500), sh(260)) });
      break;
    case "celebrate":
      [1047, 1175, 1319, 1568, 1760].forEach((f, i) => tone(buf, sr, e.t + i * 0.05, { wave: "triangle", dur: 0.05, attack: 0.005, gain: 0.06, freq: () => sh(f) }));
      [1047, 1319, 1568].forEach((f) => tone(buf, sr, e.t + 0.25, { wave: "triangle", dur: 0.4, attack: 0.005, gain: 0.045, freq: () => sh(f) }));
      [2093, 2637, 3136].forEach((f, i) => tone(buf, sr, e.t + 0.25 + i * 0.06, { wave: "sine", dur: 0.18, attack: 0.003, gain: 0.03, freq: () => f }));
      break;
  }
}

/** The whole soundtrack as mono samples, low-passed at 3.5 kHz and peak-limited. */
export function renderSound(g, o = {}) {
  const sr = o.sr ?? SR;
  const seconds = o.seconds ?? TIMES.PLAY + TIMES.HOLD;
  const buf = new Float32Array(Math.ceil(seconds * sr));
  for (const e of soundEvents(g)) play(buf, sr, e);
  // one-pole low-pass at 3.5 kHz
  const a = Math.exp((-2 * Math.PI * 3500) / sr);
  let y = 0;
  for (let i = 0; i < buf.length; i++) buf[i] = y = (1 - a) * buf[i] + a * y;
  // Peak-normalise: about -18 dBFS on the web (quiet, a bonus), about -3 dBFS for the clip (close to -14 LUFS for
  // short, sparse sound effects like these).
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const target = Math.pow(10, (o.peakDb ?? -18) / 20);
  if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] *= target / peak;
  return buf;
}

/** 16-bit PCM WAV bytes, for the clip recorder. */
export function wavBytes(samples, sr = SR) {
  const n = samples.length;
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => [...s].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF"); out.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, sr, true);
  out.setUint32(28, sr * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, "data"); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(out.buffer);
}
