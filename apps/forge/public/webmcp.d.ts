// Types for public/webmcp.js (WebMCP tools on /scan and /check), imported by test/webmcp.test.ts.
export interface ForgeWebTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: boolean };
  execute(args: unknown): Promise<string>;
}
export interface ModelContextLike {
  registerTool(tool: ForgeWebTool, options?: { signal?: AbortSignal }): unknown;
}
export declare const SCAN_MAX_TEXT: number;
export declare function modelContextOf(doc: unknown, nav: unknown): ModelContextLike | null;
export declare function forgeTools(fetchImpl: typeof fetch): { scan_skill: ForgeWebTool; check_tool: ForgeWebTool };
export declare function toolsForPath(path: string): ("scan_skill" | "check_tool")[];
export declare function registerForgeTools(mc: ModelContextLike | null, tools: Record<string, ForgeWebTool>, names: string[], signal?: AbortSignal): Promise<string[]>;
