// Types for the shared Trap Gauntlet renderer (public/gauntlet.js), imported by the Worker to draw the still frame.
import type { Gauntlet } from "@forge/arena";
export declare const PLAY: number;
export declare const HOLD: number;
export declare const END: number;
export declare function svgAt(g: Gauntlet, t: number, o?: { label?: string }): string;
export declare function terminalAt(g: Gauntlet, t: number): string;
export declare function esc(s: unknown): string;
export declare const CLIP_HOLD: number;
export declare const TIMES: Record<string, number>;
export declare function svgAt(g: Gauntlet, t: number, o?: { label?: string; geo?: "wide" | "compact" | "clip" }): string;
export declare function stampWord(l: Gauntlet["lanes"][number]): string;
export declare function robotSvg(mood: "pass" | "fell" | "alert", size?: number): string;
