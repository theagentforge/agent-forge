import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";

describe("GET /api/v1/health", () => {
  it("reports ok when the database is reachable", async () => {
    const res = await exports.default.fetch("https://forge.test/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      service: "forge",
      environment: "production",
      db: "ok",
    });
  });

  it("returns a JSON 404 for unknown API routes and an HTML 404 for pages", async () => {
    const api = await exports.default.fetch("https://forge.test/api/v1/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not_found" });
    const page = await exports.default.fetch("https://forge.test/nope");
    expect(page.status).toBe(404);
    expect(page.headers.get("Content-Type")).toContain("text/html");
  });
});
