import { defineConfig } from "drizzle-kit";

// Generates SQL migrations into migrations/; wrangler applies them (`wrangler d1 migrations apply`).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
