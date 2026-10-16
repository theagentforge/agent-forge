import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { canParticipate } from "../src/services/access";
import { getDb } from "../src/services/db";
import { submitReport } from "../src/services/forge";
import { approveLogin, upsertHuman } from "../src/services/identity";
import { checkKind, day, proofNow, recordCheck, writeSnapshot } from "../src/services/proof";
import { connectAgent, connectApprovedAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";

beforeEach(() => {
  vi.spyOn(env.AI, "run").mockImplementation((async () => ({ response: "safe" })) as never);
});

const closed = { ...env, ACCESS_MODE: "closed" } as Env;

describe("closed production (invite-only until launch)", () => {
  it("only approved, vouched or founder accounts can take part", async () => {
    const db = getDb(env);
    const stranger = await upsertHuman(db, profile(), Date.now()); // verified by GitHub activity only
    expect(canParticipate(closed, stranger)).toBe(false);
    expect(canParticipate(env, stranger)).toBe(true); // open mode

    const partner = profile();
    await approveLogin(db, partner.login, Date.now());
    expect(canParticipate(closed, await upsertHuman(db, partner, Date.now()))).toBe(true);

    const founder = await upsertHuman(db, profile({ id: Number(env.ADMIN_GITHUB_IDS), public_repos: 0, followers: 0 }), Date.now());
    expect(canParticipate(closed, founder)).toBe(true);
  });

  it("reports from people who aren't approved are refused while closed", async () => {
    const { props } = await connectAgent();
    expect(await submitReport(closed, props, report())).toMatchObject({ ok: false, reason: "invite_only" });
    const approved = await connectApprovedAgent();
    expect(await submitReport(closed, approved.props, report())).toMatchObject({ ok: true });
  });
});

describe("House accounts and the proof scoreboard", () => {
  it("House reports are labelled and counted apart from external ones", async () => {
    const house = await connectAgent();
    await getDb(env).update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, house.human.id));
    const outside = await connectAgent();
    const tool = { kind: "skill", id: "github.com/house/split", version: "1", fingerprint: fp("6") };
    await postReport(house.token, report({ tool }));
    await postReport(outside.token, report({ tool }));

    const page = await (await fetchWorker(`/a/${house.agent.handle}`)).text();
    expect(page).toContain(">house</span>");
    const before = await proofNow(env);
    expect(before.reports.house).toBeGreaterThanOrEqual(1);
    expect(before.weekly_reporting_agents.external).toBeGreaterThanOrEqual(1);
  });

  it("checks are counted once per source per day without storing IPs", async () => {
    const res = await fetchWorker("/api/v1/check?id=npm:counted", {
      headers: { "CF-Connecting-IP": "198.51.100.77", "User-Agent": "theagentforge-claude-plugin" },
    });
    expect(res.status).toBe(200);
    await recordCheck(env, "plugin", "198.51.100.77"); // the same source again the same day
    const rows = await getDb(env).select().from(t.checkSources).where(eq(t.checkSources.kind, "plugin"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).not.toContain("198.51");
    expect(rows[0]!.day).toBe(day(Date.now()));
  });

  it("checks from the forge-check GitHub Action are counted as their own kind", async () => {
    expect(checkKind("theagentforge-action/1")).toBe("ci");
    expect(checkKind("theagentforge-cli/0.1.0")).toBe("cli");
    expect(checkKind("curl/8")).toBe("api");
    const res = await fetchWorker("/api/v1/check?id=npm:ci-counted", { headers: { "CF-Connecting-IP": "198.51.100.78", "User-Agent": "theagentforge-action/1" } });
    expect(res.status).toBe(200);
    const rows = await getDb(env).select().from(t.checkSources).where(eq(t.checkSources.kind, "ci"));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("the daily snapshot saves every metric and CLI downloads, and /stats shows both columns", async () => {
    const npm = (async () => Response.json({ downloads: 42 })) as unknown as typeof fetch;
    const now = Date.now();
    const r = await writeSnapshot(env, now, npm);
    expect(r.date).toBe(day(now - 86_400_000));
    await writeSnapshot(env, now, npm); // twice a day is harmless
    const rows = await getDb(env).select().from(t.proofSnapshots).where(eq(t.proofSnapshots.date, r.date));
    expect(rows.find((x) => x.metric === "cli_npm_downloads")?.externalValue).toBe(42);
    expect(new Set(rows.map((x) => x.metric)).size).toBe(rows.length);

    const page = await (await fetchWorker("/stats")).text();
    expect(page).toContain("External");
    expect(page).toContain("House");
    expect(page).toContain(r.date);
  });
});
