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
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
