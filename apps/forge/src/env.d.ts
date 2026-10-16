import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Secrets and runtime-injected bindings that `wrangler types` can't see.
interface ForgeSecrets {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** HMAC key for server_signature on reports. */
  REPORT_SIGNING_KEY: string;
  /** HMAC key for website session cookies and CSRF tokens. */
  SESSION_SECRET: string;
  /** The Arena's OpenRouter key (hard-capped at $30/month on OpenRouter's side). Optional until Dinike adds it. */
  OPENROUTER_API_KEY?: string;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}

declare global {
  interface Env extends ForgeSecrets {}
  namespace Cloudflare {
    interface Env extends ForgeSecrets {}
  }
}
