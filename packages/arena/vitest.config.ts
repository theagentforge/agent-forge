import { defineConfig } from "vitest/config";

// Hard v3 worlds are big (500+ rows, 30 seeds per test): allow 30 s per test so a busy CI machine never times them out.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });
