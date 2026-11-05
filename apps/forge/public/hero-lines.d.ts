// Types for the home headline's one cycle (public/hero-lines.js, ADR 0130), imported by the tests.
export interface HeroRotState {
  n: number;
  start: number;
  order: number[];
  step: number;
  current: number;
  playing: boolean;
  hover: boolean;
  focus: boolean;
  hidden: boolean;
}
export type HeroRotEvent = { type: "tick" } | { type: "toggle" } | { type: "hover" | "focus" | "hidden"; on: boolean };
export declare const STEP_MS: number;
export declare const FADE_MS: number;
export declare function cycleOrder(start: number, n: number): number[];
export declare function initial(n: number, start: number, reduce: boolean): HeroRotState;
export declare function running(s: HeroRotState): boolean;
export declare function update(s: HeroRotState, ev: HeroRotEvent): HeroRotState;
export declare function buttonState(s: HeroRotState): { label: "Pause headlines" | "Play headlines"; pressed: boolean };
export declare function sameFrame(a: { action: string | null } | undefined, b: { action: string | null } | undefined): boolean;
export declare function boot(doc: Document, win: Window): { state: () => HeroRotState } | null;
