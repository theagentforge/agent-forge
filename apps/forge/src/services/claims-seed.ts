// Public copy of apps/forge/src/services/claims-seed.ts (ADR 0120). The claim registry's seed quotes the private buyer
// brief and internal documents; this stub keeps the public code building with no seeded claims.
import type { Comparator } from "./claims-core";

export interface SeedClaim {
  id: string;
  text: string;
  url: string;
  anchor_kind: "json" | "text" | "none";
  anchor_path?: string;
  expected?: string;
  comparator?: Comparator;
  tolerance?: number;
  counter?: boolean;
  author: "claude" | "boardy" | "don" | "site";
  author_model?: string;
  appears_in: string;
  made_at: string;
  retired_at?: string;
  keywords?: string[];
}

export const CLAIM_SEED: SeedClaim[] = [];
