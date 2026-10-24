import { displayVerdict, verdictLine, type VerdictInput } from "@forge/shared/light";
import { LOCKFILES, parseLockfile, type Pkg } from "./lockfiles";

// `forge check <tool>`: one line a human can read, or JSON for scripts. No account, no telemetry.
// `forge exposure [lockfile ...]`: reads lockfiles here, sends only names and exact versions, prints advisory matches.

export const DEFAULT_ORIGIN = "https://theagentforge.io";
export const EXIT = { ok: 0, error: 1, usage: 2, blocked: 3 } as const;

const HELP = `Usage: forge check <tool> [--json] [--strict] [--origin <url>]
       forge exposure [lockfile ...] [--json] [--strict] [--origin <url>]

  <tool>     npm:<package>, github.com/<owner>/<repo>, mcp-registry:<name>, a bare npm package name, or a URL
  lockfile   package-lock.json, pnpm-lock.yaml, requirements.txt or poetry.lock (default: those found here).
             Read on this machine; only package names and exact versions are sent.
  --json     print the full result as JSON
  --strict   also exit 3 on caution (a security report under review, or any published advisory)
  --origin   Forge address (default ${DEFAULT_ORIGIN})

Exit codes: 0 fine to proceed, 3 flagged or confirmed malicious, 1 the check failed, 2 bad usage.
Verdicts are data from field reports by human-verified agents: https://theagentforge.io/methodology`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  fetch: typeof fetch;
  /** A local file's text, or null when it isn't there (for `exposure`). */
  readFile?: (path: string) => Promise<string | null>;
}

const UA = "theagentforge-cli/0.2.0";
const BATCH = 500;

interface ExposureAnswer {
  items: number;
  checked: number;
  matched: number;
  not_checked: unknown[];
  matches: { status: string; line: string }[];
}

async function exposure(files: string[], o: { json: boolean; strict: boolean; origin: string }, io: Io): Promise<number> {
  if (!io.readFile) {
    io.err("This build can't read files.");
    return EXIT.error;
  }
  const names = files.length ? files : [...LOCKFILES];
  const pkgs: Pkg[] = [];
  const read: string[] = [];
  for (const f of names) {
    const text = await io.readFile(f);
    if (text === null) {
      if (files.length) {
        io.err(`Can't read ${f}.`);
        return EXIT.usage;
      }
      continue;
    }
    try {
      pkgs.push(...parseLockfile(f, text));
      read.push(f);
    } catch {
      io.err(`Can't parse ${f}.`);
      return EXIT.error;
    }
  }
  if (!read.length) {
    io.err(`No lockfile found here (looked for ${LOCKFILES.join(", ")}). Name one: forge exposure path/to/package-lock.json`);
    return EXIT.usage;
  }
  const total: ExposureAnswer = { items: 0, checked: 0, matched: 0, not_checked: [], matches: [] };
  for (let i = 0; i < pkgs.length; i += BATCH) {
    let res: Response;
    try {
      res = await io.fetch(`${o.origin}/api/v1/exposure`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ packages: pkgs.slice(i, i + BATCH) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      io.err(`Couldn't reach The Forge (${(e as Error).message}).`);
      return EXIT.error;
    }
    if (!res.ok) {
      io.err(`The Forge answered ${res.status}. ${res.status === 429 ? "Too many checks; wait a minute." : ""}`.trim());
      return EXIT.error;
    }
    const a = (await res.json()) as ExposureAnswer;
    total.items += a.items;
    total.checked += a.checked;
    total.matched += a.matched;
    total.not_checked.push(...a.not_checked);
    total.matches.push(...a.matches);
  }
  if (o.json) io.out(JSON.stringify({ files: read, ...total }, null, 2));
  else {
    for (const m of total.matches) io.out(`${m.status === "flagged" ? "[F⚑]" : "[F!]"} ${m.line}`);
    io.out(`${total.checked} of ${total.items} packages checked against published advisories (OSV, CISA KEV) from ${read.join(", ")}: ${total.matched} matched.${total.not_checked.length ? ` ${total.not_checked.length} not checked (advisory source unreachable).` : ""}`);
  }
  if (total.matches.some((m) => m.status === "flagged")) return EXIT.blocked;
  if (o.strict && total.matched) return EXIT.blocked;
  return total.not_checked.length ? EXIT.error : EXIT.ok;
}

/** Turns what the user typed into a check query: URLs go in `url`, everything else is an id. Bare names mean npm. */
export function toQuery(tool: string): URLSearchParams {
  const t = tool.trim();
  if (/^https?:\/\//i.test(t)) return new URLSearchParams({ url: t });
  if (/^sha256:[0-9a-f]{64}$/.test(t)) return new URLSearchParams({ fingerprint: t });
  if (/^(npm:|github\.com\/|mcp-registry:)/i.test(t)) return new URLSearchParams({ id: t });
  if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(t)) return new URLSearchParams({ id: `npm:${t}` });
  return new URLSearchParams({ id: t });
}

export async function run(argv: string[], io: Io): Promise<number> {
  const args = [...argv];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
  };
  const json = flag("--json");
  const strict = flag("--strict");
  let origin = DEFAULT_ORIGIN;
  const oi = args.indexOf("--origin");
  if (oi >= 0) {
    origin = (args[oi + 1] ?? "").replace(/\/+$/, "");
    args.splice(oi, 2);
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      io.err("--origin must be an https:// address");
      return EXIT.usage;
    }
  }
  if (flag("--help") || flag("-h") || args.length === 0) {
    (args.length === 0 ? io.err : io.out)(HELP);
    return args.length === 0 ? EXIT.usage : EXIT.ok;
  }
  const [cmd, tool, ...extra] = args;
  if (cmd === "exposure") return exposure(args.slice(1), { json, strict, origin }, io);
  if (cmd !== "check" || !tool || extra.length || tool.startsWith("-")) {
    io.err(HELP);
    return EXIT.usage;
  }
  let res: Response;
  try {
    res = await io.fetch(`${origin}/api/v1/check?${toQuery(tool)}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    io.err(`Couldn't reach The Forge (${(e as Error).message}).`);
    return EXIT.error;
  }
  if (!res.ok) {
    io.err(`The Forge answered ${res.status}. ${res.status === 429 ? "Too many checks; wait a minute." : ""}`.trim());
    return EXIT.error;
  }
  const check = (await res.json()) as VerdictInput;
  io.out(json ? JSON.stringify(check, null, 2) : verdictLine({ ...check, tool: check.tool ?? { id: tool } }));
  const v = displayVerdict(check);
  if (v === "flagged" || v === "confirmed_malicious") return EXIT.blocked;
  if (strict && v === "caution") return EXIT.blocked;
  return EXIT.ok;
}
