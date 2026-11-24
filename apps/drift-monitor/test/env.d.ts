declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

/** Vite raw-text imports (the wrangler.jsonc cron check). */
declare module "*?raw" {
  const text: string;
  export default text;
}
