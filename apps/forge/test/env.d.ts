declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

/** Vite's eager glob import (used by the forge-mcp package test to read public-repo/forge-mcp). */
interface ImportMeta {
  glob<T = unknown>(pattern: string | string[], options: { eager: true; query?: string; import?: string; exhaustive?: boolean }): Record<string, T>;
}

/** Vite raw-text imports (used by the design-system test to read site.css). */
declare module "*?raw" {
  const text: string;
  export default text;
}
