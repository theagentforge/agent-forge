// Build list 4 Nov, item 10 (discovery files): schema.org JSON-LD for the pages a search engine or an AI indexer is
// most likely to cite. Dataset for the Arena and the Trap Set (Google Dataset Search, Croissant-aware crawlers), and
// WebAPI plus SoftwareApplication for /connect. Facts only: names, links, licence, versions. No ratings or reviews.
import { BENCHMARK_JSON_PATH, BENCHMARK_PATH, TRAP_SET_NAME } from "../arena/benchmark";
import { BENCHMARK_LICENCE_PATH, BENCHMARK_TRAPS_PATH } from "../arena/benchmark-files";
import { DATASET_LICENCE, LICENCE_PATH } from "../services/provenance";
import { VERIFY_CLI_VERSION } from "./replay-verify";

const org = (origin: string) => ({ "@type": "Organization", name: "The Agent Forge", url: origin });

/** /arena: every refereed run in The Forge Arena, as one dataset with its JSON file and Croissant metadata. */
export function arenaDatasetLd(origin: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "The Forge Arena: refereed AI agent runs",
    description:
      "Every refereed run of AI models doing everyday business jobs (refunds, payments, bookings, stock, records) in a sandbox with planted traps: model, job, tier, pass or fail, trap ids sprung, knockouts, rules version and a signed replay for each.",
    url: `${origin}/arena`,
    isAccessibleForFree: true,
    creator: org(origin),
    license: { "@type": "CreativeWork", name: DATASET_LICENCE, url: `${origin}${LICENCE_PATH}` },
    keywords: ["AI agents", "agent evaluation", "planted traps", "prompt injection", "business policy", "benchmark"],
    distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${origin}/arena/dataset.json` }],
    subjectOf: { "@type": "CreativeWork", name: "Croissant 1.0 metadata", encodingFormat: "application/ld+json", url: `${origin}/arena/croissant.json` },
  };
}

/** /benchmark: The Forge Trap Set, versioned and citable. */
export function benchmarkDatasetLd(d: { version: string; date: string; counts: { traps: number; jobs: number }; citation: { text: string } }, origin: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: TRAP_SET_NAME,
    description: `${d.counts.traps} public planted traps in ${d.counts.jobs} everyday business jobs for AI agents, each with a schema, trigger, safe behaviour, scoring rule and sandbox cost, plus per-model results with 95% intervals.`,
    url: `${origin}${BENCHMARK_PATH}`,
    version: d.version,
    datePublished: d.date,
    citation: d.citation.text,
    isAccessibleForFree: true,
    creator: org(origin),
    license: { "@type": "CreativeWork", name: "Evaluation-only licence", url: `${origin}${BENCHMARK_LICENCE_PATH}` },
    distribution: [
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${origin}${BENCHMARK_JSON_PATH}` },
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${origin}${BENCHMARK_TRAPS_PATH}` },
    ],
  };
}

/** /connect: the public API, the MCP servers and the CLI, as software an agent builder can install. */
export function connectLd(origin: string) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebAPI",
        name: "The Agent Forge API",
        description: "Pre-install safety data on agent skills, MCP servers and packages (field reports, OSV advisories, skill scans) and refereed Arena results. Free without an account.",
        url: `${origin}/connect`,
        documentation: `${origin}/openapi.json`,
        provider: org(origin),
        isAccessibleForFree: true,
      },
      {
        "@type": "SoftwareApplication",
        name: "@theagentforge/cli",
        description: "Checks a skill, MCP server or package against The Agent Forge before an agent installs it.",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "macOS, Linux, Windows",
        softwareVersion: VERIFY_CLI_VERSION,
        downloadUrl: "https://www.npmjs.com/package/@theagentforge/cli",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: org(origin),
      },
    ],
  };
}
