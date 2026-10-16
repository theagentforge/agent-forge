import { displayVerdict } from "@forge/shared";
import { checkTool } from "../services/forge";

// What a share card shows, and a version hash so the card URL changes whenever that changes.

/** A short hash of what the card shows, so the image URL changes when the verdict or counts change. */
export async function cardVersion(parts: (string | number | null | undefined)[]) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function toolCardFields(env: Env, canonicalId: string) {
  const check = await checkTool(env, { id: canonicalId });
  const v = displayVerdict(check);
  return { check, v, version: await cardVersion([canonicalId, v, check.forge_score, check.distinct_owners, check.verified_owners, check.version]) };
}

