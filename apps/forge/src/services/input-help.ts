import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";

// First calls (26 Oct 2026): ~400 MCP sessions a day reach /mcp/public, mostly catalogs and rating bots, and many
// call a tool with no arguments or the wrong ones. A schema failure used to come back as the SDK's one-line
// "Input validation error" text. Now each tool answers with structured data: what's missing, in one plain line, and
// two or three inputs that work, given as data (never instructions, docs/launch/agent-channels.md §2).

export interface InputNeeded {
  error: string;
  data_kind: "input_needed";
  tool: string;
  /** One line: what the call needs, as a noun phrase. */
  needed: string;
  /** The first problem with what was sent, or null when nothing was sent. */
  detail: string | null;
  /** Arguments that work, each a complete call. */
  examples: Record<string, unknown>[];
  [k: string]: unknown;
}

export function inputNeeded(tool: string, o: { error?: string; needed: string; detail?: string | null; examples: Record<string, unknown>[]; extra?: Record<string, unknown> }): InputNeeded {
  return { error: o.error ?? "input_needed", data_kind: "input_needed", tool, needed: o.needed, detail: o.detail ?? null, examples: o.examples, ...o.extra };
}

/** The first zod issue as "field: message" (enum options cut short, since `examples` and the lists carry them). */
export function firstIssue(e: z.ZodError): string | null {
  const i = e.issues[0];
  if (!i) return null;
  // Zod words some messages as rules ("must match pattern"); here each is a plain statement of what was wrong.
  const own = !/^Invalid/.test(i.message);
  const msg = i.code === "invalid_value" ? "not one of the accepted values" : own ? i.message.replace(/^.*?\bmust be\b\s*/, "expected ") : i.code === "invalid_format" ? "not in the accepted format" : i.message;
  return `${i.path.length ? `${i.path.join(".")}: ` : ""}${msg}`.slice(0, 200);
}

/**
 * The tool's zod schema as published (tools/list shows exactly its JSON Schema), but accepting any object at call time,
 * so the handler validates and can answer a bad call with data instead of a protocol-level validation error.
 */
export function lenient<S extends z.ZodObject>(schema: S): StandardSchemaWithJSON<z.input<S>, Record<string, unknown>> {
  const std = schema["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: "forge-lenient",
      validate: (value: unknown) => ({ value: value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {} }),
      jsonSchema: std.jsonSchema,
    },
  } as StandardSchemaWithJSON<z.input<S>, Record<string, unknown>>;
}

/** A sha256 any agent can reproduce: the empty file's. */
export const EXAMPLE_FINGERPRINT = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const CHECK_NEEDED = "One of id (npm:<name>, pypi:<name>, github.com/<owner>/<repo>, or a bare name), url or fingerprint (sha256:<64 hex>); version optional.";
export const CHECK_EXAMPLES = [
  { id: "pypi:litellm", version: "1.107.0" },
  { id: "npm:@modelcontextprotocol/sdk" },
  { url: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch" },
];

export const SCAN_NEEDED = "text (the contents of a skill file, tool descriptions or install script) or url (a file on a public code host).";
export const SCAN_EXAMPLES = [
  { text: "---\nname: release-notes\ndescription: Drafts release notes from merged pull requests.\n---\nThis skill lists merged pull request titles under Added, Changed and Fixed.", name: "release-notes" },
  { text: "get_weather: returns the forecast for a city, given its name." },
  { url: "https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md" },
];

export const WATCH_NEEDED = "fingerprints: 1 to 100 sha256 hashes of installed skill files, as forge_scan returns them.";
export const WATCH_EXAMPLES = [{ fingerprints: [EXAMPLE_FINGERPRINT] }, { fingerprints: [EXAMPLE_FINGERPRINT.slice(7)] }];

export const EXPOSURE_NEEDED = "packages (up to 500 of ecosystem npm or pypi, name and exact version) or pip_freeze text with name==version lines.";
export const EXPOSURE_EXAMPLES = [
  { packages: [{ ecosystem: "pypi", name: "litellm", version: "1.107.0" }] },
  { packages: [{ ecosystem: "npm", name: "lodash", version: "4.17.20" }, { ecosystem: "npm", name: "@modelcontextprotocol/sdk", version: "1.32.2" }] },
  { pip_freeze: "litellm==1.107.0\nrequests==2.32.3" },
];
