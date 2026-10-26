import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyState,
  NUDGE_TEXT,
  recordFailure,
  recordSuccess,
  safeSessionId,
  summary,
  type SessionState,
} from "../strain-state";
import { byServer, draftMessage, drafts, MAX_DRAFTS, mergeCounts, type InstallDraftLine } from "../report-draft";
import { toStrain } from "../strain-state";
import { draftableInstalls, installDraft, ledgerKey, markOutcome, parseInstalls } from "../installs";
import { draftReport } from "@forge/shared/light";
import { commandHash, dataRoot, emit, forgeOrigin, installsPath, optionOn, readStdin, readText, sha256Hex, writeText } from "./common";

// PostToolUseFailure / PostToolUse: count failures per tool in a local session file (MASTER_PLAN §6.10).
// `show` prints the counts for the most recent session, for the agent to attach to a field report.
// `stop` (Stop hook, ADR 0011 f) drafts reports for the MCP servers used this session, and for tools the pre-install
// hook checked that were then installed (src/installs.ts), with the owner's one-line yes/no question as data. Never
// sends a report anywhere: filing needs the owner's confirmation. The only network call is the npm registry lookup
// of an installed version's fingerprint.

const WEEK_MS = 7 * 86_400_000;

const dataDir = () => join(dataRoot(), "strain");

function load(file: string): SessionState {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionState;
  } catch {
    return emptyState();
  }
}

function prune(dir: string, now: number) {
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs > WEEK_MS) unlinkSync(p);
    }
  } catch {}
}

const inputHash = (input: unknown) => createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex").slice(0, 16);

async function record(mode: "failure" | "success") {
  const ev = (await readStdin()) as { session_id?: unknown; tool_name?: unknown; tool_input?: unknown; is_interrupt?: unknown };
  if (typeof ev.tool_name !== "string" || ev.is_interrupt === true) return;
  // An install the pre-install hook checked: note whether it worked, for its field report draft.
  const command = (ev.tool_input as { command?: unknown } | null)?.command;
  if (ev.tool_name === "Bash" && typeof command === "string") {
    const text = readText(installsPath());
    if (text) {
      const installs = parseInstalls(text);
      if (markOutcome(installs, safeSessionId(ev.session_id), commandHash(command), mode === "success")) writeText(installsPath(), JSON.stringify(installs));
    }
  }
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const file = join(dir, `${safeSessionId(ev.session_id)}.json`);
  const state = load(file);
  let nudge = false;
  if (mode === "failure") nudge = recordFailure(state, ev.tool_name, inputHash(ev.tool_input), now);
  else recordSuccess(state, ev.tool_name, now);
  writeFileSync(file, JSON.stringify(state));
  if (Math.random() < 0.05) prune(dir, now);
  if (nudge && optionOn("NUDGE")) {
    emit({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: NUDGE_TEXT }, systemMessage: NUDGE_TEXT });
  }
}

async function stop() {
  const ev = (await readStdin()) as { session_id?: unknown; stop_hook_active?: unknown };
  if (ev.stop_hook_active === true || !optionOn("REPORT_DRAFTS")) return;
  const dir = dataDir();
  const file = join(dir, `${safeSessionId(ev.session_id)}.json`);
  const state = load(file);
  const ledgerFile = join(dir, "..", "drafted.json");
  let ledger: Record<string, number> = {};
  try {
    ledger = JSON.parse(readFileSync(ledgerFile, "utf8")) as Record<string, number>;
  } catch {}
  const now = Date.now();
  const list = drafts(state, ledger, now);
  const pending = draftableInstalls(parseInstalls(readText(installsPath())), safeSessionId(ev.session_id), ledger, now, MAX_DRAFTS - list.length);
  const origin = forgeOrigin();
  const signal = AbortSignal.timeout(2500);
  const installs = (await Promise.all(pending.map((i) => installDraft(i, origin, { fetch, sha256Hex, signal }))))
    .filter((d) => d !== null)
    .map((d): InstallDraftLine => ({ id: d.draft.tool.id, line: d.line, url: d.url, report: draftReport(d.draft) }));
  if (!list.length && !installs.length) return;
  for (const d of list) ledger[d.server] = now;
  for (const i of installs) ledger[ledgerKey(i.id)] = now;
  writeText(ledgerFile, JSON.stringify(ledger));
  // "block" keeps the agent going for one more turn, with the drafts as data; stop_hook_active stops a second round.
  emit({ decision: "block", reason: draftMessage(list, installs, origin) });
}

function show(args: string[]) {
  const toolIdx = args.indexOf("--tool");
  const tool = toolIdx >= 0 ? args[toolIdx + 1] : undefined;
  const serverIdx = args.indexOf("--server");
  const server = serverIdx >= 0 ? args[serverIdx + 1] : undefined;
  const dir = dataDir();
  let latest: string | null = null;
  let latestM = 0;
  try {
    for (const f of readdirSync(dir)) {
      const m = statSync(join(dir, f)).mtimeMs;
      if (m > latestM) [latest, latestM] = [join(dir, f), m];
    }
  } catch {}
  const state = latest ? load(latest) : null;
  if (server !== undefined) {
    const list = state ? byServer(state).get(server) : undefined;
    process.stdout.write(JSON.stringify(list ? toStrain(mergeCounts(list)) : null, null, 2) + "\n");
    return;
  }
  const all = state ? summary(state) : {};
  process.stdout.write(JSON.stringify(tool ? (all[tool] ?? null) : all, null, 2) + "\n");
}

const [mode, ...rest] = process.argv.slice(2);
if (process.env.VITEST === undefined) {
  if (mode === "failure" || mode === "success") record(mode).catch(() => {});
  else if (mode === "stop") stop().catch(() => {});
  else if (mode === "show") show(rest);
}
