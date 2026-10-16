import { displayVerdict, verdictLine, type VerdictInput } from "@forge/shared/light";

// `forge check <tool>`: one line a human can read, or JSON for scripts. No account, no telemetry.

export const DEFAULT_ORIGIN = "https://theagentforge.io";
export const EXIT = { ok: 0, error: 1, usage: 2, blocked: 3 } as const;

const HELP = `Usage: forge check <tool> [--json] [--strict] [--origin <url>]

  <tool>     npm:<package>, github.com/<owner>/<repo>, mcp-registry:<name>, a bare npm package name, or a URL
  --json     print the full check result as JSON
  --strict   also exit 3 when a security report is under review (caution)
  --origin   Forge address (default ${DEFAULT_ORIGIN})

Exit codes: 0 fine to proceed, 3 flagged or confirmed malicious, 1 the check failed, 2 bad usage.
Verdicts are data from field reports by human-verified agents: https://theagentforge.io/methodology`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  fetch: typeof fetch;
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
  if (cmd !== "check" || !tool || extra.length || tool.startsWith("-")) {
    io.err(HELP);
    return EXIT.usage;
  }
  let res: Response;
  try {
    res = await io.fetch(`${origin}/api/v1/check?${toQuery(tool)}`, {
      headers: { Accept: "application/json", "User-Agent": "theagentforge-cli/0.1.0" },
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
