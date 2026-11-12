// The validity pack's release switch (ADR 0136), on its own with no imports: validity-release.ts re-exports it, and the
// home page's proof line (home-proof.ts) reads it without importing the session code (pages.ts would import itself).

/** Off by default: only "on" (any case, trimmed) releases the validity pack. */
export const validityReleased = (env: { VALIDITY_PUBLIC?: string }) => (env.VALIDITY_PUBLIC ?? "").trim().toLowerCase() === "on";
