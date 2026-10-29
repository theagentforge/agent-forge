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
import type { Duel } from "@forge/arena";
export type CardPart = { text?: string; html?: string; hidden?: boolean; picks?: [string, string] };
export type CardParts = { run: string } & Record<string, CardPart>;
export declare const CARD_PARTS: string[];
export declare const FOOT_NOTE: string;
export declare function runIdOf(d: Duel): string;
export declare function cardLabel(d: Duel): string;
export declare function shareText(d: Duel): string;
export declare function footHtml(d: Duel): string;
export declare function cardParts(d: Duel, t: number, o?: { tease?: string | null; geo?: "wide" | "compact" | "clip" }): CardParts;
export interface CardElement { textContent: string | null; innerHTML: string; hidden: boolean; setAttribute(n: string, v: string): void; getAttribute(n: string): string | null; querySelectorAll?: (sel: string) => ArrayLike<unknown> & { forEach(f: (b: any) => void): void } }
export declare function applyCard(q: (sel: string) => CardElement | null, parts: CardParts, root?: { getAttribute(n: string): string | null; setAttribute(n: string, v: string): void }): boolean;
