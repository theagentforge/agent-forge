// Runs apps/forge/public/site.js against a small fake page, without a browser, to catch script errors that only show
// up in the browser console (the Screens run records those on the live site). addEventListener here throws like the
// browser's does when the handler isn't a function: "parameter 2 is not of type 'Object'".
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SITE_JS = readFileSync(new URL("../../apps/forge/public/site.js", import.meta.url), "utf8");

/** A fake element: attributes, children looked up by the exact selector the script uses, and checked listeners. */
function el({ attrs = {}, kids = {}, text = "" } = {}) {
  const classes = new Set();
  const e = {
    attrs: { ...attrs },
    listeners: {},
    hidden: false,
    textContent: text,
    getAttribute: (n) => (n in e.attrs ? e.attrs[n] : null),
    setAttribute: (n, v) => { e.attrs[n] = String(v); },
    removeAttribute: (n) => { delete e.attrs[n]; },
    querySelector: (s) => (kids[s] ?? [])[0] ?? null,
    querySelectorAll: (s) => kids[s] ?? [],
    classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    addEventListener: (type, fn) => {
      if (typeof fn !== "function") throw new TypeError(`addEventListener("${type}"): parameter 2 is not of type 'Object'.`);
      (e.listeners[type] ??= []).push(fn);
    },
  };
  return e;
}

/** Runs site.js on a page made of `found` (selector → elements) and returns what it touched. */
function run({ found = {}, byId = {}, hash = "", navigator = { webdriver: true } } = {}) {
  const fetched = [];
  const doc = el({ kids: found });
  doc.documentElement = { dataset: {} };
  doc.getElementById = (id) => byId[id] ?? null;
  doc.visibilityState = "visible";
  const store = new Map();
  const win = {
    document: doc,
    navigator,
    location: { hash },
    history: { replaceState() {} },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: (url) => { fetched.push(url); return new Promise(() => {}); },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    matchMedia: () => ({ matches: false }),
    JSON,
    Date,
  };
  win.window = win;
  runInNewContext(SITE_JS, win);
  return { doc, fetched };
}

/** The /connect page as connect.ts renders it, cut down to what site.js reads. */
function connectPage() {
  const tile = (id) => el({ attrs: { "data-tile": id } });
  const install = el({ attrs: { "data-install": "cursor" } });
  const copy = (id) => el({ attrs: { "data-copy": id } });
  const tab = (id) => el({ attrs: { "data-tab": id }, kids: { ".btn.primary, .btn": [el()] } });
  const again = el();
  const box = el({
    attrs: { "data-default-tab": "claude", "data-test-code": "abc123", "data-copy-apps": JSON.stringify({ cc: "claude-code" }) },
    kids: {
      "[data-tab]": [tab("claude"), tab("chatgpt")],
      "[data-tile]": [tile("claude"), tile("chatgpt")],
      ".checklist li": [el(), el(), el()],
      "[data-progress-label]": [el()],
      "[data-test-status]": [el()],
      "[data-test-help]": [el()],
      "[data-test-again]": [again],
      "[data-install]": [install],
      "[data-copy]": [copy("cc"), copy("not-counted")],
    },
  });
  const prompt = el({ text: "Use The Agent Forge to check the tool npm:forge-test-abc123" });
  return { box, again, prompt, install, found: { "[data-connect]": [box] }, byId: { "test-prompt": prompt } };
}

describe("site.js in a page", () => {
  it("runs on a page with none of its parts", () => {
    expect(() => run()).not.toThrow();
  });

  it("/connect: shows one tab, wires every button and starts waiting for the test check", () => {
    const p = connectPage();
    const { doc, fetched } = run({ found: p.found, byId: p.byId });
    expect(p.box.querySelectorAll("[data-tab]").map((t) => t.hidden)).toEqual([false, true]);
    expect(p.again.listeners.click).toHaveLength(1);
    expect(doc.listeners.visibilitychange).toHaveLength(1);
    expect(fetched).toEqual(["/api/v1/connect-test/abc123"]);
    expect(p.box.querySelector("[data-test-status]").textContent).toBe("Waiting for your first check…");
  });

  it("/connect: counts a tile, an install link and a copy once each per page load, by fixed names (ADR 0050)", () => {
    const p = connectPage();
    const beacons = [];
    run({ found: p.found, byId: p.byId, navigator: { sendBeacon: (u) => beacons.push(u) } });
    const click = (e) => (e.listeners.click ?? []).forEach((fn) => fn({ preventDefault() {} }));
    const [claudeTile] = p.box.querySelectorAll("[data-tile]");
    click(claudeTile);
    click(claudeTile);
    click(p.install);
    for (const b of p.box.querySelectorAll("[data-copy]")) click(b);
    expect(beacons).toEqual(["/v", "/connect/step?e=tile&app=claude", "/connect/step?e=copied&app=cursor", "/connect/step?e=copied&app=claude-code"]);
    // Automated browsers send nothing.
    const q = connectPage();
    const none = [];
    run({ found: q.found, byId: q.byId, navigator: { webdriver: true, sendBeacon: (u) => none.push(u) } });
    click(q.box.querySelectorAll("[data-tile]")[0]);
    expect(none).toEqual([]);
  });

  it("/connect: a #tab- link opens that tab and the test still starts", () => {
    const p = connectPage();
    const { fetched } = run({ found: p.found, byId: p.byId, hash: "#tab-chatgpt" });
    expect(p.box.querySelectorAll("[data-tab]").map((t) => t.hidden)).toEqual([true, false]);
    expect(fetched).toHaveLength(1);
  });
});
