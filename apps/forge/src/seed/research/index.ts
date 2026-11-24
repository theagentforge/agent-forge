// Frozen versions of the referee-validity research report (ADR 0149), bundled as text (wrangler.jsonc "rules") so each
// is served byte for byte. A version is frozen once (docs/runbooks/research-artefacts.md) and never changed: each
// sha256 was taken from the file when it was frozen, and test/research-validity.test.ts fails if a file's bytes change.
import v1 from "./referee-validity-v1.json.txt";

export interface ResearchSnapshot {
  version: number;
  date: string;
  sha256: string;
  text: string;
}

const text = (m: unknown) => {
  if (typeof m !== "string") throw new Error("research snapshot not bundled as text: check the wrangler.jsonc rules");
  return m;
};

export const REFEREE_VALIDITY_SNAPSHOTS: ResearchSnapshot[] = [
  { version: 1, date: "2026-11-13", sha256: "521ddecbbd91f02f50227edd68c5226e5f893a54765ee83b7b9fe35eead1bf34", text: text(v1) },
];
