import { osvPackageFor, pypiName } from "./advisories";

// "Is <package> safe to install?" pages (build list item 14, ADR 0127): the fixed list of packages that get an indexed
// page at /is-it-safe/<ecosystem>/<name> and a place in the sitemap. Any other npm or PyPI package that resolves in its
// registry still gets a page, kept out of search and the sitemap (noindex, follow), so junk names never become pages.
//
// Hand-picked on 5 Nov 2026 from well-known, widely installed packages, with no network at build time: the npm and PyPI
// names people and agents most often ask about, plus the agent ecosystem (the MCP SDKs and reference servers, model
// SDKs, agent frameworks) and a few packages with a well-known compromised or sabotaged release. Change the list by
// editing it here and bumping TOP_PACKAGES_VERSION; names are stored in their canonical form (npm: lower case; PyPI:
// PEP 503 normalised).

export const TOP_PACKAGES_VERSION = "2026-11-05";

export type PackageEcosystem = "npm" | "pypi";

export const TOP_NPM: readonly string[] = [
  // Web servers, frameworks and front end
  "express", "body-parser", "cors", "helmet", "morgan", "multer", "koa", "fastify", "next", "react", "react-dom", "vue",
  "svelte", "@angular/core", "jquery", "socket.io", "ws", "graphql", "@apollo/client", "redux", "@reduxjs/toolkit",
  "styled-components", "tailwindcss", "classnames", "prop-types",
  // Utilities
  "lodash", "lodash-es", "underscore", "axios", "node-fetch", "form-data", "qs", "uuid", "moment", "moment-timezone",
  "dayjs", "date-fns", "chalk", "colors", "debug", "commander", "yargs", "minimist", "inquirer", "ora", "dotenv",
  "cross-env", "glob", "rimraf", "mkdirp", "fs-extra", "semver", "async", "bluebird", "rxjs", "immer", "tslib",
  "zod", "joi", "yup", "ajv", "cheerio", "ua-parser-js", "event-stream", "node-ipc",
  // Build and test tooling
  "typescript", "ts-node", "nodemon", "webpack", "vite", "esbuild", "rollup", "@babel/core", "postcss", "autoprefixer",
  "sass", "eslint", "prettier", "jest", "vitest", "mocha", "chai", "puppeteer", "playwright",
  // Data and auth
  "mongoose", "pg", "mysql2", "sqlite3", "redis", "ioredis", "sequelize", "prisma", "@prisma/client", "jsonwebtoken",
  "bcrypt", "bcryptjs", "passport",
  // Agent ecosystem: MCP SDK, inspector and reference servers, model SDKs, agent frameworks
  "@modelcontextprotocol/sdk", "@modelcontextprotocol/inspector", "@modelcontextprotocol/server-filesystem",
  "@modelcontextprotocol/server-memory", "@modelcontextprotocol/server-everything",
  "@modelcontextprotocol/server-sequential-thinking", "@modelcontextprotocol/server-github",
  "@modelcontextprotocol/server-puppeteer", "@modelcontextprotocol/server-brave-search",
  "@modelcontextprotocol/server-postgres", "@modelcontextprotocol/server-slack", "@playwright/mcp",
  "@upstash/context7-mcp", "@anthropic-ai/sdk", "@anthropic-ai/claude-code", "openai", "ai", "@ai-sdk/openai",
  "langchain", "@langchain/core", "@langchain/openai", "llamaindex",
];

export const TOP_PYPI: readonly string[] = [
  // Foundations
  "requests", "urllib3", "certifi", "idna", "charset-normalizer", "setuptools", "pip", "wheel", "packaging", "six",
  "python-dateutil", "pyyaml", "typing-extensions", "attrs", "click", "jinja2", "markupsafe", "cryptography",
  "boto3", "botocore", "protobuf", "grpcio", "tqdm", "rich",
  // Web and data
  "flask", "django", "fastapi", "uvicorn", "gunicorn", "httpx", "aiohttp", "pydantic", "sqlalchemy", "beautifulsoup4",
  "lxml", "pillow", "numpy", "pandas", "scipy", "matplotlib", "scikit-learn", "pytest",
  // Machine learning
  "torch", "tensorflow", "transformers", "huggingface-hub", "tiktoken", "ultralytics",
  // Agent ecosystem: MCP SDK and reference servers, model SDKs, agent frameworks
  "mcp", "fastmcp", "mcp-server-fetch", "mcp-server-git", "mcp-server-time", "openai", "anthropic", "litellm",
  "langchain", "langchain-core", "llama-index", "crewai",
];

export const IS_IT_SAFE_PATH = "/is-it-safe";

const LISTED = { npm: new Set(TOP_NPM), pypi: new Set(TOP_PYPI) };

/** The canonical name of an npm or PyPI package (npm: lower case; PyPI: PEP 503), or null when it isn't a valid name. */
export function canonicalPackageName(ecosystem: PackageEcosystem, name: string): string | null {
  if (!name || name.length > 214) return null;
  const pkg = osvPackageFor(`${ecosystem}:${name}`);
  if (!pkg) return null;
  return ecosystem === "pypi" ? pypiName(pkg.name) : pkg.name;
}

export const isListedPackage = (ecosystem: PackageEcosystem, name: string) => LISTED[ecosystem].has(name);

/** The page for a package: /is-it-safe/npm/express, /is-it-safe/npm/@scope/name, /is-it-safe/pypi/requests. */
export const packagePagePath = (ecosystem: PackageEcosystem, name: string) => `${IS_IT_SAFE_PATH}/${ecosystem}/${name}`;

/** Every listed package's page, npm first, in list order. */
export const TOP_PACKAGE_PATHS: readonly string[] = [
  ...TOP_NPM.map((n) => packagePagePath("npm", n)),
  ...TOP_PYPI.map((n) => packagePagePath("pypi", n)),
];
