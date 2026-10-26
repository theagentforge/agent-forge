// WebMCP (W3C Web Machine Learning CG draft; Chrome origin trial, Meta AI preview): read-only tools an in-browser
// agent can call on /scan and /check. The API lives on document.modelContext (July 2026 draft); Chrome 146-149 put it
// on navigator.modelContext, deprecated from Chrome 150, so both are tried. Where neither exists nothing happens.
// Each tool calls the same public REST API as everyone else (same rate limits) and returns its JSON as a string.
// Descriptions are plain data about what the tool returns, never instructions (AGENTS.md rule 7).

export const SCAN_MAX_TEXT = 262144; // SCAN_MAX_BYTES in @forge/shared

/** The modelContext object, or null when this browser has no WebMCP. */
export function modelContextOf(doc, nav) {
  for (const mc of [doc && doc.modelContext, nav && nav.modelContext]) if (mc && typeof mc.registerTool === "function") return mc;
  return null;
}

async function answer(res) {
  try {
    return JSON.stringify(await res.json());
  } catch {
    return JSON.stringify({ error: "unavailable", status: res.status });
  }
}

/** The tool definitions. `fetchImpl` is the page's fetch (same origin, so relative URLs). */
export function forgeTools(fetchImpl) {
  return {
    scan_skill: {
      name: "scan_skill",
      description:
        "The Agent Forge skill scan. Input: the text of an agent skill file, MCP tool descriptions or an install script, or a public file URL (GitHub, ClawHub, GitLab, Codeberg, unpkg, jsDelivr). Output: JSON with verdict (clear, caution or flagged), counts, rule ids with line numbers, fingerprint and a signed receipt URL. clear means no known pattern matched, not that the file is safe. Read only.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: SCAN_MAX_TEXT, description: "File text to scan." },
          url: { type: "string", format: "uri", description: "Public URL of the file, used when text is not given." },
        },
      },
      annotations: { readOnlyHint: true },
      async execute(args) {
        const a = args && typeof args === "object" ? args : {};
        const body = typeof a.text === "string" && a.text ? { text: a.text } : typeof a.url === "string" && a.url ? { url: a.url } : null;
        if (!body) return JSON.stringify({ error: "give text or url" });
        return answer(await fetchImpl("/api/v1/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      },
    },
    check_tool: {
      name: "check_tool",
      description:
        "The Agent Forge tool check. Input: a tool id (npm:<package>, pypi:<package>, github.com/<owner>/<repo>, mcp-registry:<name> or a bare name) and an optional exact version. Output: JSON with verdict (insufficient, clear, caution, flagged or confirmed_malicious), security_status, field report counts from other agents, published OSV advisories for npm and PyPI versions, and a signed receipt URL. insufficient means too few reports. Read only.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", maxLength: 512, description: "Tool id, e.g. npm:@modelcontextprotocol/server-filesystem." },
          version: { type: "string", maxLength: 128, description: "Exact version, e.g. 1.2.3." },
        },
        required: ["id"],
      },
      annotations: { readOnlyHint: true },
      async execute(args) {
        const a = args && typeof args === "object" ? args : {};
        if (typeof a.id !== "string" || !a.id.trim()) return JSON.stringify({ error: "give id" });
        const q = new URLSearchParams({ id: a.id.trim() });
        if (typeof a.version === "string" && a.version.trim()) q.set("version", a.version.trim());
        return answer(await fetchImpl(`/api/v1/check?${q}`, { headers: { Accept: "application/json" } }));
      },
    },
  };
}

/** Which tools a page offers. */
export function toolsForPath(path) {
  if (path === "/scan" || path === "/scan/") return ["scan_skill"];
  if (path === "/check" || path === "/check/") return ["check_tool"];
  return [];
}

/** Registers the named tools; returns the names that registered. Never throws. */
export async function registerForgeTools(mc, tools, names, signal) {
  const done = [];
  if (!mc) return done;
  for (const n of names) {
    try {
      await mc.registerTool(tools[n], signal ? { signal } : undefined);
      done.push(n);
    } catch {
      // A tool of that name already registered, or the browser refused it: the page works the same either way.
    }
  }
  return done;
}

if (typeof document !== "undefined" && typeof location !== "undefined") {
  const mc = modelContextOf(document, typeof navigator !== "undefined" ? navigator : null);
  const names = toolsForPath(location.pathname);
  // Tools belong to the document and go with it, so no unregistering is needed.
  if (mc && names.length) registerForgeTools(mc, forgeTools(fetch.bind(globalThis)), names);
}
