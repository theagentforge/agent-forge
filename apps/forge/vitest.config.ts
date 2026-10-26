import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Workers AI only runs remotely; tests replace moderation with a stub instead.
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, "migrations")),
          // Test-only values; real secrets live in Cloudflare.
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          REPORT_SIGNING_KEY: "test-signing-key",
          SESSION_SECRET: "test-session-secret",
          // Most tests exercise open sign-up; test/closed-mode.test.ts covers the closed (pre-launch) rules.
          ACCESS_MODE: "open",
        },
      },
    })),
  ],
  // CSS is stubbed out in tests unless included; test/clips.test.ts reads clip.css as text.
  // Timeouts: these are integration tests (a whole Worker, D1 and PNG rendering in workerd), not unit tests. Alone, the
  // heaviest take 1-3 s (a full Gauntlet over MCP; three share images at ~0.5 s each), but the full suite runs many
  // files in parallel and CI machines are shared, so Vitest's 5 s default failed gauntlet-claims and fail-card at
  // random. A real hang still fails, at 30 s.
  test: { setupFiles: ["./test/apply-migrations.ts"], css: { include: [/clip\.css/] }, testTimeout: 30_000, hookTimeout: 60_000 },
});
