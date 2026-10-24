import { describe, expect, it } from "vitest";
import { fromPackageLock, fromPnpmLock, fromPoetryLock, fromRequirements, parseLockfile } from "../src/lockfiles";
import { EXIT, run } from "../src/run";

// C5 (crisis-wave plan): lockfiles are read on the user's machine; only names and exact versions are sent.

const PACKAGE_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "": { name: "app", version: "1.0.0" },
    "node_modules/lodash": { version: "4.17.20", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz", integrity: "sha512-secretish" },
    "node_modules/@scope/pkg": { version: "2.0.0" },
    "node_modules/a/node_modules/lodash": { version: "4.17.21" },
    "node_modules/linked": { link: true, resolved: "../linked" },
  },
});
const PNPM_LOCK = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      lodash:
        specifier: ^4
        version: 4.17.20

packages:

  lodash@4.17.20:
    resolution: {integrity: sha512-x}

  '@scope/pkg@2.0.0':
    resolution: {integrity: sha512-y}

  react-dom@18.3.1(react@18.3.1):
    resolution: {integrity: sha512-z}

snapshots:

  other@9.9.9: {}
`;
const POETRY = `[[package]]
name = "litellm"
version = "1.107.0"
description = "x"

[package.dependencies]
httpx = ">=0.23"

[[package]]
name = "requests"
version = "2.34.2"
`;

describe("lockfiles", () => {
  it("reads package-lock.json, keeping names and versions only", () => {
    expect(fromPackageLock(PACKAGE_LOCK)).toEqual([
      { ecosystem: "npm", name: "lodash", version: "4.17.20" },
      { ecosystem: "npm", name: "@scope/pkg", version: "2.0.0" },
      { ecosystem: "npm", name: "lodash", version: "4.17.21" },
    ]);
    expect(fromPackageLock(JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } } } }))).toEqual([
      { ecosystem: "npm", name: "a", version: "1.0.0" },
      { ecosystem: "npm", name: "b", version: "2.0.0" },
    ]);
  });

  it("reads pnpm-lock.yaml packages (v9 and v5 keys), not importers or snapshots", () => {
    expect(fromPnpmLock(PNPM_LOCK)).toEqual([
      { ecosystem: "npm", name: "lodash", version: "4.17.20" },
      { ecosystem: "npm", name: "@scope/pkg", version: "2.0.0" },
      { ecosystem: "npm", name: "react-dom", version: "18.3.1" },
    ]);
    expect(fromPnpmLock("packages:\n  /left-pad/1.3.0:\n    resolution: {}\n  /@a/b/2.0.0_react@18:\n    dev: false\n")).toEqual([
      { ecosystem: "npm", name: "left-pad", version: "1.3.0" },
      { ecosystem: "npm", name: "@a/b", version: "2.0.0" },
    ]);
  });

  it("reads requirements.txt and poetry.lock", () => {
    expect(fromRequirements("litellm==1.107.0\nflask>=3\n# x\n-r other.txt\nrequests[socks]==2.34.2 ; python_version > '3'\n")).toEqual([
      { ecosystem: "pypi", name: "litellm", version: "1.107.0" },
      { ecosystem: "pypi", name: "requests", version: "2.34.2" },
    ]);
    expect(fromPoetryLock(POETRY)).toEqual([
      { ecosystem: "pypi", name: "litellm", version: "1.107.0" },
      { ecosystem: "pypi", name: "requests", version: "2.34.2" },
    ]);
    expect(parseLockfile("x/unknown.lock", "anything")).toEqual([]);
  });
});

function io(files: Record<string, string>, answer: unknown, status = 200) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: unknown[] = [];
  return {
    out,
    err,
    sent,
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      readFile: async (p: string) => files[p] ?? null,
      fetch: (async (_u: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return Response.json(answer, { status });
      }) as unknown as typeof fetch,
    },
  };
}

const ANSWER = {
  items: 2,
  checked: 2,
  matched: 1,
  not_checked: [],
  matches: [{ status: "flagged", line: "litellm 1.107.0 matches MAL-2026-2144; no fixed version listed; source https://osv.dev/vulnerability/MAL-2026-2144" }],
};

describe("forge exposure", () => {
  it("finds lockfiles here, sends names and versions only, prints matches and exits 3 on flagged", async () => {
    const t = io({ "poetry.lock": POETRY }, ANSWER);
    expect(await run(["exposure"], t.io)).toBe(EXIT.blocked);
    expect(t.sent).toEqual([{ packages: [{ ecosystem: "pypi", name: "litellm", version: "1.107.0" }, { ecosystem: "pypi", name: "requests", version: "2.34.2" }] }]);
    expect(JSON.stringify(t.sent)).not.toMatch(/httpx|description|poetry/);
    expect(t.out[0]).toBe("[F⚑] litellm 1.107.0 matches MAL-2026-2144; no fixed version listed; source https://osv.dev/vulnerability/MAL-2026-2144");
    expect(t.out[1]).toContain("2 of 2 packages checked");
  });

  it("exits 0 with no match, 3 on caution only with --strict, and 2 when there's no lockfile", async () => {
    const none = { ...ANSWER, matched: 0, matches: [] };
    expect(await run(["exposure", "requirements.txt"], io({ "requirements.txt": "a==1.0.0\n" }, none).io)).toBe(EXIT.ok);
    const caution = { ...ANSWER, matches: [{ status: "caution", line: "lodash 4.17.20 matches GHSA-x" }] };
    expect(await run(["exposure", "package-lock.json"], io({ "package-lock.json": PACKAGE_LOCK }, caution).io)).toBe(EXIT.ok);
    expect(await run(["exposure", "package-lock.json", "--strict"], io({ "package-lock.json": PACKAGE_LOCK }, caution).io)).toBe(EXIT.blocked);
    const empty = io({}, none);
    expect(await run(["exposure"], empty.io)).toBe(EXIT.usage);
    expect(empty.err[0]).toContain("No lockfile found");
    expect(await run(["exposure", "missing.txt"], io({}, none).io)).toBe(EXIT.usage);
  });

  it("reports a failed request as an error, never as clear", async () => {
    expect(await run(["exposure", "poetry.lock"], io({ "poetry.lock": POETRY }, {}, 503).io)).toBe(EXIT.error);
    expect(await run(["exposure", "poetry.lock"], io({ "poetry.lock": POETRY }, { ...ANSWER, checked: 0, matched: 0, matches: [], not_checked: [{}] }).io)).toBe(EXIT.error);
  });
});
