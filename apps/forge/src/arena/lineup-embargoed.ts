import type { ArenaModel } from "./lineup";

// Models in the lineup under embargo: run, refereed and stored, shown nowhere until published. The real list is
// private; this copy holds one stand-in so the embargo tests (apps/forge/test/fixtures/embargoed.ts) run here too.
// It is not a real model and never runs.
export const EMBARGOED_LINEUP: ArenaModel[] = [
  { id: "embargoed-stand-in", name: "Embargoed Stand-in", lab: "Test", division: "heavyweight", embargoed: true, route: { kind: "openrouter", model: "test/embargoed-stand-in", provider: "test" } },
];
