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
  /** Smithery registry API key (B3-14, ADR 0108). Optional: the Smithery census seeder is off without it. */
  SMITHERY_API_KEY?: string;
  /** ADR 0098: the key for the bulk export's pseudonyms (owner_*, agent_*, report_*). Optional; SESSION_SECRET until set. */
  EXPORT_PSEUDONYM_KEY?: string;
  /**
   * ADR 0102: the R2 bucket `forge-backups` for the weekly off-site copy. Not in wrangler.jsonc until Dinike enables
   * R2 (docs/runbooks/backups.md); while it is missing the weekly copy does nothing.
   */
  BACKUPS?: R2Bucket;
  /** ADR 0110: HMAC key for API key hashes. Optional; until set, a key derived from SESSION_SECRET is used (hash_v "s"). */
  API_KEY_PEPPER?: string;
  /** ADR 0110: Polar's webhook signing secret (Standard Webhooks). Set by Dinike in Cloudflare; the webhook answers 404 without it. */
  POLAR_WEBHOOK_SECRET?: string;
  /** ADR 0110: Polar organisation access token, for checkout and customer-portal sessions. Needed only in PRICING_MODE "paid". */
  POLAR_ACCESS_TOKEN?: string;
  /**
   * ADR 0110: not a secret. JSON naming the Polar product id of each plan and billing interval:
   * {"team_month":"<id>","team_year":"<id>","volume_month":"<id>","volume_year":"<id>"}.
   */
  POLAR_PRODUCTS?: string;
  /** ADR 0110: "sandbox" for Polar's sandbox API (staging); production otherwise. */
  POLAR_SERVER?: string;
  /** Injected by OAuthProvider into the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}

declare global {
  interface Env extends ForgeSecrets {}
  namespace Cloudflare {
    interface Env extends ForgeSecrets {}
  }
}
