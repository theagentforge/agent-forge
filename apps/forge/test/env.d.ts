declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

/** Vite raw-text imports (used by the design-system test to read site.css). */
declare module "*?raw" {
  const text: string;
  export default text;
}
