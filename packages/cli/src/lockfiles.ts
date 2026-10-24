// Reads installed package names and exact versions from lockfiles, on the user's machine. Only {ecosystem, name,
// version} leave this file: never paths, hashes, registry URLs or anything else in the lockfile (crisis-wave plan C5).

export interface Pkg {
  ecosystem: "npm" | "pypi";
  name: string;
  version: string;
}

export const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "requirements.txt", "poetry.lock"] as const;

const NPM_NAME = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_!-]{0,63}$/;

function push(out: Pkg[], ecosystem: Pkg["ecosystem"], name: string, version: string) {
  if (VERSION.test(version) && (ecosystem === "pypi" ? /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) : NPM_NAME.test(name))) out.push({ ecosystem, name, version });
}

/** package-lock.json, lockfile versions 1 to 3. */
export function fromPackageLock(text: string): Pkg[] {
  const out: Pkg[] = [];
  const lock = JSON.parse(text) as { packages?: Record<string, { version?: unknown; link?: unknown }>; dependencies?: Record<string, unknown> };
  if (lock.packages) {
    for (const [path, p] of Object.entries(lock.packages)) {
      const name = path.split("node_modules/").pop();
      if (!path || !name || p?.link || typeof p?.version !== "string") continue;
      push(out, "npm", name, p.version);
    }
    return out;
  }
  const walk = (deps: Record<string, unknown> | undefined) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      const dep = d as { version?: unknown; dependencies?: Record<string, unknown> };
      if (typeof dep?.version === "string") push(out, "npm", name, dep.version);
      walk(dep?.dependencies);
    }
  };
  walk(lock.dependencies);
  return out;
}

/** pnpm-lock.yaml (lockfile 5 to 9): the keys under `packages:`. */
export function fromPnpmLock(text: string): Pkg[] {
  const out: Pkg[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inPackages = /^packages:\s*$/.test(line);
    if (!inPackages) continue;
    const key = /^ {2}['"]?([^\s'"]+?)['"]?:\s*$/.exec(line)?.[1];
    if (!key) continue;
    const k = key.replace(/^\//, "").replace(/\(.*$/, "");
    // Lockfile 5: /name/1.2.3 or /@scope/name/1.2.3_peer@x; later: name@1.2.3 or /@scope/name@1.2.3.
    const v5 = /^((?:@[^/]+\/)?[^/@]+)\/(\d[^/_]*)(?:_.*)?$/.exec(k);
    const at = k.lastIndexOf("@");
    if (v5) push(out, "npm", v5[1]!, v5[2]!);
    else if (at > 0) push(out, "npm", k.slice(0, at), k.slice(at + 1));
  }
  return out;
}

/** requirements.txt or pip freeze: `name==version` lines only. */
export function fromRequirements(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([A-Za-z0-9.+!_-]+)\s*(?:;.*)?$/.exec(raw.replace(/\s+#.*$/, "").trim());
    if (m) push(out, "pypi", m[1]!, m[2]!);
  }
  return out;
}

/** poetry.lock: each [[package]] table's name and version. */
export function fromPoetryLock(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\[(?!\[package\])/m)[0] ?? "";
    const name = /^name\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    if (name && version) push(out, "pypi", name, version);
  }
  return out;
}

/** The packages in one lockfile, chosen by its file name. Duplicates removed. */
export function parseLockfile(fileName: string, text: string): Pkg[] {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const list = base === "package-lock.json" || base === "npm-shrinkwrap.json" ? fromPackageLock(text) : base === "pnpm-lock.yaml" ? fromPnpmLock(text) : base === "poetry.lock" ? fromPoetryLock(text) : /requirements.*\.txt$|\.txt$/.test(base) ? fromRequirements(text) : [];
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = `${p.ecosystem}:${p.name.toLowerCase()}@${p.version}`;
    return !seen.has(k) && !!seen.add(k);
  });
}
