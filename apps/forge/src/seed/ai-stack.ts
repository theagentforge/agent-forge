import { eq, inArray } from "drizzle-orm";
import * as t from "../db/schema";
import { pypiName } from "../services/advisories";
import { getDb } from "../services/db";
import { upsertSeedTools, type SeedTool } from "./mcp-registry";
import { REFERENCE_SERVERS } from "./reference-servers";

// Issue #203: the AI-stack packages agents check during incidents (pypi:litellm was our top miss in the week of
// 24 Oct) weren't tools we knew, so a check had no tool page, no Forge Score and nowhere to file a report, and
// counted as a miss. This seeds the packages the Scout collector watches for malicious-package records
// (docs/ops/competitors.yml `crisis_packages`, the list behind `crisis_radar.watched_packages`) as known tools,
// labelled "ai-stack", the same way the reference servers are seeded (issue #170).
//
// `repo` is the GitHub repository the package's own registry metadata names (npm `repository`, PyPI `project_urls`),
// read on 26 Oct 2026; it is left out where the metadata names none. When several packages live in one repository,
// only the first listed one takes the repository as an alias (an alias names one tool).

export interface AiPackage {
  ecosystem: "npm" | "pypi";
  name: string;
  repo?: string;
  /** False for a watched name with no package on the registry (watched for squatting, not seeded as a tool). */
  published?: false;
}

export const AI_STACK_PACKAGES: AiPackage[] = [
  { ecosystem: "pypi", name: "litellm", repo: "BerriAI/litellm" },
  { ecosystem: "pypi", name: "openai", repo: "openai/openai-python" },
  { ecosystem: "pypi", name: "anthropic", repo: "anthropics/anthropic-sdk-python" },
  { ecosystem: "pypi", name: "langchain", repo: "langchain-ai/langchain" },
  { ecosystem: "pypi", name: "langchain-core", repo: "langchain-ai/langchain" },
  { ecosystem: "pypi", name: "langchain-community", repo: "langchain-ai/langchain-community" },
  { ecosystem: "pypi", name: "langchain-openai", repo: "langchain-ai/langchain" },
  { ecosystem: "pypi", name: "langgraph", repo: "langchain-ai/langgraph" },
  { ecosystem: "pypi", name: "llama-index", repo: "run-llama/llama_index" },
  { ecosystem: "pypi", name: "llama-index-core", repo: "run-llama/llama_index" },
  { ecosystem: "pypi", name: "transformers", repo: "huggingface/transformers" },
  { ecosystem: "pypi", name: "huggingface-hub", repo: "huggingface/huggingface_hub" },
  { ecosystem: "pypi", name: "tokenizers", repo: "huggingface/tokenizers" },
  { ecosystem: "pypi", name: "accelerate", repo: "huggingface/accelerate" },
  { ecosystem: "pypi", name: "vllm", repo: "vllm-project/vllm" },
  { ecosystem: "pypi", name: "sentence-transformers", repo: "huggingface/sentence-transformers" },
  { ecosystem: "pypi", name: "torch", repo: "pytorch/pytorch" },
  { ecosystem: "pypi", name: "tensorflow", repo: "tensorflow/tensorflow" },
  { ecosystem: "pypi", name: "google-genai", repo: "googleapis/python-genai" },
  { ecosystem: "pypi", name: "google-generativeai", repo: "google/generative-ai-python" },
  { ecosystem: "pypi", name: "mistralai", repo: "mistralai/client-python" },
  { ecosystem: "pypi", name: "cohere", repo: "cohere-ai/cohere-python" },
  { ecosystem: "pypi", name: "groq", repo: "groq/groq-python" },
  { ecosystem: "pypi", name: "ollama", repo: "ollama/ollama-python" },
  { ecosystem: "pypi", name: "instructor", repo: "567-labs/instructor" },
  { ecosystem: "pypi", name: "pydantic-ai", repo: "pydantic/pydantic-ai" },
  { ecosystem: "pypi", name: "crewai", repo: "crewAIInc/crewAI" },
  { ecosystem: "pypi", name: "autogen-agentchat" },
  { ecosystem: "pypi", name: "pyautogen" },
  { ecosystem: "pypi", name: "autogen", repo: "ag2ai/ag2classic" },
  { ecosystem: "pypi", name: "dspy", repo: "stanfordnlp/dspy" },
  { ecosystem: "pypi", name: "semantic-kernel", repo: "microsoft/semantic-kernel" },
  { ecosystem: "pypi", name: "haystack-ai", repo: "deepset-ai/haystack" },
  { ecosystem: "pypi", name: "chromadb", repo: "chroma-core/chroma" },
  { ecosystem: "pypi", name: "pinecone", repo: "pinecone-io/python-sdk" },
  { ecosystem: "pypi", name: "qdrant-client", repo: "qdrant/qdrant-client" },
  { ecosystem: "pypi", name: "weaviate-client", repo: "weaviate/weaviate-python-client" },
  { ecosystem: "pypi", name: "faiss-cpu", repo: "facebookresearch/faiss" },
  { ecosystem: "pypi", name: "tiktoken", repo: "openai/tiktoken" },
  { ecosystem: "pypi", name: "gradio", repo: "gradio-app/gradio" },
  { ecosystem: "pypi", name: "streamlit", repo: "streamlit/streamlit" },
  { ecosystem: "pypi", name: "mlflow", repo: "mlflow/mlflow" },
  { ecosystem: "pypi", name: "ray", repo: "ray-project/ray" },
  { ecosystem: "pypi", name: "comfyui" },
  { ecosystem: "pypi", name: "mcp", repo: "modelcontextprotocol/python-sdk" },
  { ecosystem: "pypi", name: "fastmcp", repo: "PrefectHQ/fastmcp" },
  { ecosystem: "pypi", name: "smolagents" },
  { ecosystem: "pypi", name: "openai-agents", repo: "openai/openai-agents-python" },
  { ecosystem: "pypi", name: "browser-use", repo: "browser-use/browser-use" },
  { ecosystem: "pypi", name: "playwright", repo: "microsoft/playwright-python" },
  { ecosystem: "pypi", name: "e2b", repo: "e2b-dev/e2b" },
  { ecosystem: "pypi", name: "modal", repo: "modal-labs/modal-client" },
  { ecosystem: "pypi", name: "together", repo: "togethercomputer/together-py" },
  { ecosystem: "pypi", name: "replicate", repo: "replicate/replicate-python" },
  { ecosystem: "pypi", name: "guidance", repo: "guidance-ai/guidance" },
  { ecosystem: "pypi", name: "outlines", repo: "dottxt-ai/outlines" },
  { ecosystem: "pypi", name: "promptflow", repo: "microsoft/promptflow" },
  { ecosystem: "pypi", name: "litserve", repo: "Lightning-AI/litserve" },
  { ecosystem: "pypi", name: "unstructured", repo: "Unstructured-IO/unstructured" },
  { ecosystem: "pypi", name: "pypdf", repo: "py-pdf/pypdf" },
  { ecosystem: "pypi", name: "datasets", repo: "huggingface/datasets" },
  { ecosystem: "npm", name: "openai", repo: "openai/openai-node" },
  { ecosystem: "npm", name: "@anthropic-ai/sdk", repo: "anthropics/anthropic-sdk-typescript" },
  { ecosystem: "npm", name: "@anthropic-ai/claude-code", repo: "anthropics/claude-code" },
  { ecosystem: "npm", name: "@modelcontextprotocol/sdk", repo: "modelcontextprotocol/typescript-sdk" },
  // Seeded as reference servers (reference-servers.ts), so skipped here.
  { ecosystem: "npm", name: "@modelcontextprotocol/server-filesystem" },
  { ecosystem: "npm", name: "@modelcontextprotocol/server-github" },
  { ecosystem: "npm", name: "@modelcontextprotocol/inspector", repo: "modelcontextprotocol/inspector" },
  { ecosystem: "npm", name: "langchain", repo: "langchain-ai/langchainjs" },
  { ecosystem: "npm", name: "@langchain/core", repo: "langchain-ai/langchainjs" },
  { ecosystem: "npm", name: "@langchain/openai", repo: "langchain-ai/langchainjs" },
  { ecosystem: "npm", name: "@langchain/langgraph", repo: "langchain-ai/langgraphjs" },
  { ecosystem: "npm", name: "ai", repo: "vercel/ai" },
  { ecosystem: "npm", name: "@ai-sdk/openai", repo: "vercel/ai" },
  { ecosystem: "npm", name: "@ai-sdk/anthropic", repo: "vercel/ai" },
  { ecosystem: "npm", name: "@google/genai", repo: "googleapis/js-genai" },
  { ecosystem: "npm", name: "@google/generative-ai", repo: "google/generative-ai-js" },
  { ecosystem: "npm", name: "@mistralai/mistralai", repo: "mistralai/client-ts" },
  { ecosystem: "npm", name: "ollama", repo: "ollama/ollama-js" },
  { ecosystem: "npm", name: "llamaindex", repo: "run-llama/LlamaIndexTS" },
  { ecosystem: "npm", name: "@huggingface/inference", repo: "huggingface/huggingface.js" },
  { ecosystem: "npm", name: "@huggingface/transformers", repo: "huggingface/transformers.js" },
  { ecosystem: "npm", name: "@xenova/transformers", repo: "xenova/transformers.js" },
  // No such package on npm (26 Oct 2026: 404); watched in case someone publishes it.
  { ecosystem: "npm", name: "@vercel/ai", published: false },
  { ecosystem: "npm", name: "@openai/agents", repo: "openai/openai-agents-js" },
  { ecosystem: "npm", name: "@openai/codex", repo: "openai/codex" },
  { ecosystem: "npm", name: "@google/gemini-cli", repo: "google-gemini/gemini-cli" },
  { ecosystem: "npm", name: "fastmcp", repo: "punkpeye/fastmcp" },
  { ecosystem: "npm", name: "mcp-remote", repo: "punkpeye/mcp-remote" },
  { ecosystem: "npm", name: "@playwright/mcp", repo: "microsoft/playwright-mcp" },
  { ecosystem: "npm", name: "puppeteer", repo: "puppeteer/puppeteer" },
  { ecosystem: "npm", name: "playwright", repo: "microsoft/playwright" },
  { ecosystem: "npm", name: "chromadb" },
  { ecosystem: "npm", name: "@pinecone-database/pinecone", repo: "pinecone-io/pinecone-ts-client" },
  { ecosystem: "npm", name: "tiktoken", repo: "dqbd/tiktoken" },
  { ecosystem: "npm", name: "js-tiktoken", repo: "dqbd/tiktoken" },
  { ecosystem: "npm", name: "@qdrant/js-client-rest", repo: "qdrant/qdrant-js" },
  { ecosystem: "npm", name: "n8n", repo: "n8n-io/n8n" },
  { ecosystem: "npm", name: "flowise" },
  { ecosystem: "npm", name: "@mastra/core", repo: "mastra-ai/mastra" },
  { ecosystem: "npm", name: "@langchain/anthropic", repo: "langchain-ai/langchainjs" },
];

/** MCP servers among them; the rest are libraries, SDKs and agent apps, filed under "api". */
const MCP_SERVERS = new Set(["npm:@playwright/mcp", "npm:mcp-remote"]);
const REFERENCE_NPM = new Set(REFERENCE_SERVERS.flatMap((r) => (r.npm ? [`npm:${r.npm.toLowerCase()}`] : [])));

const idOf = (p: AiPackage) => (p.ecosystem === "npm" ? `npm:${p.name.toLowerCase()}` : `pypi:${pypiName(p.name)}`);

/** The packages that become tools: published, and not already seeded as reference servers. */
export function aiStackSeedTools(list: AiPackage[] = AI_STACK_PACKAGES): SeedTool[] {
  const repoOwner = new Map<string, string>();
  const out: SeedTool[] = [];
  for (const p of list) {
    const canonicalId = idOf(p);
    if (p.published === false || REFERENCE_NPM.has(canonicalId) || out.some((x) => x.canonicalId === canonicalId)) continue;
    const repoUrl = p.repo ? `https://github.com/${p.repo}` : null;
    const githubId = p.repo ? `github.com/${p.repo.toLowerCase()}` : null;
    const ownsRepo = !!githubId && !repoOwner.has(githubId);
    if (githubId && ownsRepo) repoOwner.set(githubId, canonicalId);
    // PyPI treats -, _ and . alike (PEP 503), and agents write either: pypi:llama_index finds pypi:llama-index.
    const spellings = p.ecosystem === "pypi" ? [`pypi:${p.name.toLowerCase().replace(/-/g, "_")}`] : [];
    const aliases = [...new Set([...(ownsRepo ? [githubId!] : []), ...spellings].filter((a) => a !== canonicalId))];
    const registry = p.ecosystem === "npm" ? "npm" : "PyPI";
    out.push({
      canonicalId,
      aliases,
      sourceUrl: repoUrl ?? (p.ecosystem === "npm" ? `https://www.npmjs.com/package/${p.name}` : `https://pypi.org/project/${p.name}/`),
      publisherGithub: p.repo ? p.repo.split("/")[0]!.toLowerCase() : null,
      kind: MCP_SERVERS.has(canonicalId) ? "mcp_server" : "api",
      signal: {
        title: `${p.name} (${registry})`,
        description: "A widely used AI or agent package, watched daily for new malicious-package records in OSV.",
        ai_stack: true,
        package: { type: p.ecosystem, id: p.name },
        registry_url: p.ecosystem === "npm" ? `https://www.npmjs.com/package/${p.name}` : `https://pypi.org/project/${p.name}/`,
        repository: repoUrl,
      },
    });
  }
  return out;
}

const STATE_KEY = "seed:ai-stack:v1";

/**
 * Seeds the AI-stack packages once (and again whenever STATE_KEY's version is bumped). A package that's already a
 * tool under another id (e.g. an MCP Registry server whose npm package is an alias) gets the new aliases on that tool,
 * never a second tool.
 */
export async function seedAiStack(env: Env, now = Date.now()) {
  if (await env.KV.get(STATE_KEY)) return 0;
  const db = getDb(env);
  const items = aiStackSeedTools();
  const ids = items.map((i) => i.canonicalId);
  const owners = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const known = new Set((await db.select({ id: t.tools.canonicalId }).from(t.tools).where(inArray(t.tools.canonicalId, chunk))).map((r) => r.id));
    const aliased = await db
      .select({ alias: t.toolAliases.alias, canonicalId: t.tools.canonicalId })
      .from(t.toolAliases)
      .innerJoin(t.tools, eq(t.tools.id, t.toolAliases.toolId))
      .where(inArray(t.toolAliases.alias, chunk));
    for (const a of aliased) if (!known.has(a.alias)) owners.set(a.alias, a.canonicalId);
  }
  const resolved = items.map((it) => {
    const owner = owners.get(it.canonicalId);
    return owner ? { ...it, canonicalId: owner, aliases: [...new Set([it.canonicalId, ...it.aliases])] } : it;
  });
  const unique = [...new Map(resolved.map((i) => [i.canonicalId, i])).values()];
  const written = await upsertSeedTools(db, unique, now, "ai-stack");
  await env.KV.put(STATE_KEY, String(now));
  return written;
}
