import { upsertSeedTools, type SeedTool } from "./mcp-registry";
import { getDb } from "../services/db";

// The MCP project's own reference servers aren't in the official MCP Registry, so registry seeding never creates them,
// and checks for them came back "unknown" (issue #170: npm:@modelcontextprotocol/server-filesystem is our own example
// id). This small static list seeds them once, labelled "mcp-reference". Checked 23 Oct 2026 against
// github.com/modelcontextprotocol/servers (src/) and servers-archived (src/), and npm (`deprecated` field) / PyPI.

const CURRENT = "https://github.com/modelcontextprotocol/servers/tree/main/src";
const ARCHIVED = "https://github.com/modelcontextprotocol/servers-archived/tree/main/src";

interface Ref {
  dir: string;
  npm?: string;
  pypi?: string;
  archived: boolean;
}

export const REFERENCE_SERVERS: Ref[] = [
  { dir: "everything", npm: "@modelcontextprotocol/server-everything", archived: false },
  { dir: "fetch", pypi: "mcp-server-fetch", archived: false },
  { dir: "filesystem", npm: "@modelcontextprotocol/server-filesystem", archived: false },
  { dir: "git", pypi: "mcp-server-git", archived: false },
  { dir: "memory", npm: "@modelcontextprotocol/server-memory", archived: false },
  { dir: "sequentialthinking", npm: "@modelcontextprotocol/server-sequential-thinking", archived: false },
  { dir: "time", pypi: "mcp-server-time", archived: false },
  { dir: "aws-kb-retrieval-server", npm: "@modelcontextprotocol/server-aws-kb-retrieval", archived: true },
  { dir: "brave-search", npm: "@modelcontextprotocol/server-brave-search", archived: true },
  { dir: "everart", npm: "@modelcontextprotocol/server-everart", archived: true },
  { dir: "gdrive", npm: "@modelcontextprotocol/server-gdrive", archived: true },
  { dir: "github", npm: "@modelcontextprotocol/server-github", archived: true },
  { dir: "gitlab", npm: "@modelcontextprotocol/server-gitlab", archived: true },
  { dir: "google-maps", npm: "@modelcontextprotocol/server-google-maps", archived: true },
  { dir: "postgres", npm: "@modelcontextprotocol/server-postgres", archived: true },
  { dir: "puppeteer", npm: "@modelcontextprotocol/server-puppeteer", archived: true },
  { dir: "redis", npm: "@modelcontextprotocol/server-redis", archived: true },
  { dir: "sentry", pypi: "mcp-server-sentry", archived: true },
  { dir: "slack", npm: "@modelcontextprotocol/server-slack", archived: true },
  { dir: "sqlite", pypi: "mcp-server-sqlite", archived: true },
];

/** Maps a reference server to a tool: the npm package if there is one, else the GitHub folder; other forms are aliases. */
export function referenceSeedTool(r: Ref): SeedTool {
  const repoUrl = `${r.archived ? ARCHIVED : CURRENT}/${r.dir}`;
  const githubId = `github.com/modelcontextprotocol/${r.archived ? "servers-archived" : "servers"}/tree/main/src/${r.dir}`;
  // The old location, which many READMEs and configs still link to.
  const oldGithubId = `github.com/modelcontextprotocol/servers/tree/main/src/${r.dir}`;
  const npmId = r.npm ? `npm:${r.npm.toLowerCase()}` : null;
  const pypiId = r.pypi ? `pypi:${r.pypi.toLowerCase()}` : null;
  const canonicalId = npmId ?? githubId;
  const aliases = [...new Set([githubId, oldGithubId, pypiId].filter((x): x is string => !!x && x !== canonicalId))];
  return {
    canonicalId,
    aliases,
    sourceUrl: repoUrl,
    publisherGithub: "modelcontextprotocol",
    signal: {
      reference_server: true,
      maintainer: "Model Context Protocol project",
      status: r.archived ? "archived" : "active",
      package_deprecated: r.archived,
      repository: repoUrl,
      packages: [r.npm ? { type: "npm", id: r.npm } : null, r.pypi ? { type: "pypi", id: r.pypi } : null].filter(Boolean),
    },
  };
}

const STATE_KEY = "seed:mcp-reference:v1";

/** Seeds the reference servers once (and again whenever STATE_KEY's version is bumped). */
export async function seedReferenceServers(env: Env, now = Date.now()) {
  if (await env.KV.get(STATE_KEY)) return 0;
  const written = await upsertSeedTools(getDb(env), REFERENCE_SERVERS.map(referenceSeedTool), now, "mcp-reference");
  await env.KV.put(STATE_KEY, String(now));
  return written;
}
