// Public copy of apps/forge/src/services/data-room-private.ts (ADR 0095). The real asset schedule, cost table and
// legal items are private (buyers see them under NDA in the data room); this stub keeps the public code building.
export type AssetLicence = "MIT" | "Apache-2.0 (code) + evaluation-only (task data)" | "All rights reserved, published for audit" | "Private (not published)" | "Evaluation only, not for training";
export interface AssetRow { asset: string; where: string; licence: AssetLicence; exclusive: boolean; note: string }
export interface CostRow { provider: string; what: string; cost: string; expires: string | null; source: string; if_it_stops: string }
export const ASSET_SCHEDULE: AssetRow[] = [];
export const COSTS: CostRow[] = [];
export const LEGAL_ITEMS: { item: string; status: string; needs: string }[] = [];
export const CHECKLIST: { area: string; where: string; status: string }[] = [];
