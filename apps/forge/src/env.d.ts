import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

// Secrets and runtime-injected bindings that `wrangler types` can't see.
interface ForgeSecrets {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** HMAC key for server_signature on reports. */
  REPORT_SIGNING_KEY: string;
  /** HMAC key for website session cookies and CSRF tokens. */
  SESSION_SECRET: string;
  /** The Arena's OpenRouter key (hard-capped on OpenRouter's side: $30/month, $50 for October 2026). Optional until Dinike adds it. */
  OPENROUTER_API_KEY?: string;
  /** ADR 0061: the Agentverse connection URL (https://<handle>:<key>@agentverse.ai/<Agent%20Name>). Optional; without it the listing is inert. */
  AGENTVERSE_CONNECTION?: string;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}

declare global {
  interface Env extends ForgeSecrets {}
  namespace Cloudflare {
    interface Env extends ForgeSecrets {}
  }
}
