import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { startGauntlet } from "../src/arena/gauntlet";
import { OPS_MODE_KEY, opsMode, resetOpsModeCache } from "../src/services/ops-mode";
import { bump } from "../src/services/usage";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";
import { eq } from "drizzle-orm";

// ADR 0027: in lean mode nothing writes on a visitor's behalf, so a traffic spike costs requests only.

afterEach(async () => {
  await env.KV.delete(OPS_MODE_KEY);
  resetOpsModeCache();
});

describe("the cost guard's lean mode", () => {
  it("is off by default and on when the KV switch says lean (read at most once a minute)", async () => {
    expect(await opsMode(env)).toBe("normal");
    await env.KV.put(OPS_MODE_KEY, "lean");
    expect(await opsMode(env)).toBe("normal"); // still the cached value
    resetOpsModeCache();
    expect(await opsMode(env)).toBe("lean");
  });

  it("skips usage counters, refuses new Gauntlet runs and serves the static share image", async () => {
    await env.KV.put(OPS_MODE_KEY, "lean");
    resetOpsModeCache();
    await bump(env, ["test:lean-counter"]);
    const rows = await getDb(env).select().from(t.usageDaily).where(eq(t.usageDaily.key, "test:lean-counter"));
    expect(rows).toHaveLength(0);
    expect(await startGauntlet(env, "198.51.100.99")).toMatchObject({ error: "busy_today" });
    const og = await fetchWorker("/og/trap-card.png", { redirect: "manual" });
    expect(og.status).toBe(302);
    expect(og.headers.get("Location")).toContain("/og/site.png");
  });

  it("in normal mode, counters write as before", async () => {
    await bump(env, ["test:normal-counter"]);
    const rows = await getDb(env).select().from(t.usageDaily).where(eq(t.usageDaily.key, "test:normal-counter"));
    expect(rows).toHaveLength(1);
  });
});
