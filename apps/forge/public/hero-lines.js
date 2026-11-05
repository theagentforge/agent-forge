// The home headline's one cycle (ADR 0130; Dinike, 5 Nov 10:39: a one-time visitor must see several of the jobs, not
// only the fake invoice). The server renders the visit's line, every backed line's words and source are in
// data-hero-lines, and the hero reserves the tallest line's height (zero layout shift). This walks once through the
// other lines, about 4.5 s each with a short opacity fade, and stops on the line the visit started with. It pauses
// while hovered, while a link in the hero has keyboard focus, and while the tab is hidden; the Pause button stops it
// (WCAG 2.2.2). With reduced motion nothing moves until the visitor presses Play (WCAG 2.3.3). No announcements:
// the h1 is aria-live="off"; its text is always the current line. No network: nothing is fetched.

export const STEP_MS = 4500;
export const FADE_MS = 250;

/** The lines shown after the first, in order: the others once, then back to the first. Empty for 0 or 1 lines. */
export function cycleOrder(start, n) {
  if (n < 2) return [];
  const out = [];
  for (let k = 1; k <= n; k++) out.push((start + k) % n);
  return out;
}

/** The rotation's state. Reduced motion: paused from the start (the visitor can still press Play). */
export function initial(n, start, reduce) {
  const s = Math.min(Math.max(0, start | 0), Math.max(0, n - 1));
  return { n, start: s, order: cycleOrder(s, n), step: 0, current: s, playing: !reduce && n > 1, hover: false, focus: false, hidden: false };
}

/** Whether the next line is due to come up (the timer runs only then). */
export const running = (s) => s.playing && !s.hover && !s.focus && !s.hidden && s.step < s.order.length;

/** The one state machine: tick (a step is due), toggle (the button), hover / focus / hidden (pauses). Pure. */
export function update(s, ev) {
  switch (ev.type) {
    case "tick": {
      if (!running(s)) return s;
      const step = s.step + 1;
      return { ...s, step, current: s.order[step - 1], playing: step < s.order.length };
    }
    case "toggle":
      if (s.playing) return { ...s, playing: false };
      if (s.n < 2) return s;
      // Play after the cycle ended (or before it began, with reduced motion): one more cycle from the current line.
      if (s.step >= s.order.length || s.step === 0) return { ...s, playing: true, step: 0, start: s.current, order: cycleOrder(s.current, s.n) };
      return { ...s, playing: true };
    case "hover":
      return { ...s, hover: !!ev.on };
    case "focus":
      return { ...s, focus: !!ev.on };
    case "hidden":
      return { ...s, hidden: !!ev.on };
    default:
      return s;
  }
}

/** The button's accessible name and pressed state (pressed = paused, as the Arena's Pause button). */
export const buttonState = (s) => ({ label: s.playing ? "Pause headlines" : "Play headlines", pressed: !s.playing });

/** Whether two lines share the sentence frame, so only the action phrase changes. */
export const sameFrame = (a, b) => !!(a && b && a.action && b.action);

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** The h1's content for a line: the frame with the action phrase in its own span, or the line's own words. */
function fillH1(doc, h1, l) {
  h1.textContent = "";
  if (l.action) {
    h1.append(doc.createTextNode("An AI agent "), el(doc, "span", "hero-act", l.action), doc.createTextNode(" and "), el(doc, "em", null, l.em), doc.createTextNode(l.tail));
  } else h1.append(doc.createTextNode(l.lead), el(doc, "em", null, l.em), doc.createTextNode(l.tail));
}

/** The source line for a line, built from data (never HTML strings). */
function fillSource(doc, p, l) {
  p.textContent = "";
  const kind = el(doc, "span", null, l.kind);
  kind.title = l.title;
  const a = el(doc, "a", null, "Watch the replay");
  a.href = l.href;
  p.append(el(doc, "span", "muted", "Refereed replay:"), doc.createTextNode(" "), kind, doc.createTextNode(` · ${l.name} · ${l.day} · `), a);
  p.setAttribute("data-hero-source", l.run);
  p.setAttribute("data-hero-line", l.key);
}

export function boot(doc, win) {
  const root = doc.querySelector("[data-hero-rot]");
  if (!root) return null;
  let lines;
  try {
    lines = JSON.parse(root.getAttribute("data-hero-lines") || "[]");
  } catch (e) {
    return null;
  }
  const h1 = root.querySelector("h1");
  const src = root.querySelector("[data-hero-source]");
  const btn = root.querySelector("[data-hero-pause]");
  if (!Array.isArray(lines) || lines.length < 2 || !h1 || !src || !btn) return null;
  const reduce = !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
  let s = initial(lines.length, Number(root.getAttribute("data-start")) || 0, reduce);
  let timer = 0;
  const label = () => {
    const b = buttonState(s);
    // The label span carries the accessible name; the icon (CSS, from aria-pressed) is hidden from readers.
    const text = btn.querySelector("[data-hero-pause-label]");
    if (text) text.textContent = b.label;
    else btn.textContent = b.label;
    btn.setAttribute("aria-pressed", String(b.pressed));
  };
  // The h1 is rebuilt on every change (new nodes are not layout shifts; moving old ones would be). With the shared
  // frame only the action phrase fades; a line with its own words fades whole. Opacity only, no sliding or typing.
  const show = (from, to) => {
    const a = lines[from];
    const b = lines[to];
    const frame = sameFrame(a, b);
    const swap = () => {
      fillH1(doc, h1, b);
      fillSource(doc, src, b);
    };
    if (reduce) return swap();
    const out = frame ? [h1.querySelector(".hero-act"), src] : [h1, src];
    out.forEach((x) => x && x.classList.add("hero-fade"));
    win.setTimeout(() => {
      swap();
      const back = frame ? [h1.querySelector(".hero-act"), src] : [h1, src];
      back.forEach((x) => x && x.classList.add("hero-fade"));
      win.requestAnimationFrame(() => win.requestAnimationFrame(() => back.forEach((x) => x && x.classList.remove("hero-fade"))));
    }, FADE_MS);
  };
  const go = (ev) => {
    const before = s.current;
    s = update(s, ev);
    if (s.current !== before) show(before, s.current);
    label();
    win.clearTimeout(timer);
    if (running(s)) timer = win.setTimeout(() => go({ type: "tick" }), STEP_MS);
  };
  btn.addEventListener("click", () => go({ type: "toggle" }));
  root.addEventListener("mouseenter", () => go({ type: "hover", on: true }));
  root.addEventListener("mouseleave", () => go({ type: "hover", on: false }));
  // Keyboard focus on a link in the hero holds the line still; the Pause button itself doesn't (it would block Play).
  root.addEventListener("focusin", (e) => go({ type: "focus", on: e.target !== btn }));
  root.addEventListener("focusout", (e) => {
    if (!root.contains(e.relatedTarget)) go({ type: "focus", on: false });
  });
  doc.addEventListener("visibilitychange", () => go({ type: "hidden", on: doc.visibilityState === "hidden" }));
  btn.classList.remove("hero-pause-off");
  go({ type: "hidden", on: doc.visibilityState === "hidden" });
  return { state: () => s };
}

if (typeof document !== "undefined" && typeof window !== "undefined") boot(document, window);
