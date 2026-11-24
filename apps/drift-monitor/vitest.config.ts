import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The poller's tests run in workerd against a D1 built from the site's own migrations (apps/forge/migrations), so the
// raw SQL here is checked against the real schema. No test reaches the network: every poll gets a fake fetch.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "../forge/migrations")) } },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"], testTimeout: 30_000, hookTimeout: 60_000 },
});
