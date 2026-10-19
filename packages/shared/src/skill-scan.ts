// The skill scanner (ADR 0026): reads the text of an agent skill (SKILL.md and friends), an MCP server's tool
// descriptions or an install script, and flags the patterns behind real attacks on agents: instructions hidden from
// the user, piping downloads into a shell, reading credential files, sending data to throwaway endpoints, invisible
// characters, and instructions to fetch and follow remote text. Pure functions, no network, no model: it costs
// nothing to run and gives the same answer for the same text, so results are reproducible and version-pinned.
//
// Wording rule: a finding says "matches pattern X at line N". It never says "malicious"; that's a human call.

export const SCAN_RULES_VERSION = "2026-10-19.3";
export const SCAN_MAX_BYTES = 262_144;

export type ScanSeverity = "high" | "medium" | "low";
export type ScanFamily = "exec" | "secrets" | "exfil" | "hidden" | "injection" | "persistence" | "remote" | "money" | "destructive" | "obfuscation" | "permissions";
export type ScanVerdict = "flagged" | "caution" | "clear";

export interface ScanRule {
  id: string;
  family: ScanFamily;
  severity: ScanSeverity;
  /** A noun phrase about the text, never an instruction (AGENTS.md rule 7). */
  title: string;
  /** Why it matters, one sentence. */
  why: string;
  re: RegExp;
}

const r = (id: string, family: ScanFamily, severity: ScanSeverity, title: string, why: string, re: RegExp): ScanRule => ({ id, family, severity, title, why, re });

const EXFIL_HOSTS =
  /\b(webhook\.site|requestbin\.(com|net)|[a-z0-9]+\.m\.pipedream\.net|pastebin\.com|paste\.ee|hastebin\.com|transfer\.sh|file\.io|0x0\.st|interact\.sh|[a-z0-9]+\.oast\.(fun|me|pro|live|site|online)|burpcollaborator\.net|hookbin\.com|beeceptor\.com|requestcatcher\.com|canarytokens\.com)\b/i;

export const SCAN_RULES: ScanRule[] = [
  r("FS-EXE-001", "exec", "high", "A download piped straight into a shell", "Runs whatever the remote server sends, unseen, with your agent's permissions.", /\b(curl|wget)\b[^\n|]{0,300}\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/i),
  r("FS-EXE-002", "exec", "high", "A shell running a download as a command", "Runs remote content through sh -c or eval.", /\b((ba|z|da)?sh|bash)\s+-c\s+["']?\$\(\s*(curl|wget)\b|\beval\s+["']?\$\(\s*(curl|wget)\b|\bsource\s+<\(\s*(curl|wget)\b/i),
  r("FS-EXE-003", "exec", "high", "PowerShell running downloaded code", "Invoke-Expression on downloaded text runs it unseen.", /\b(iex|invoke-expression)\b[^\n]{0,200}\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)\b|\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]{0,200}\|\s*(iex|invoke-expression)\b/i),
  r("FS-EXE-004", "exec", "high", "Decoded base64 piped into a shell", "Hides the real command from anyone reading the file.", /base64\s+(-d|--decode|-D)\b[^\n]{0,200}\|\s*(sudo\s+)?(ba|z)?sh\b|echo\s+[A-Za-z0-9+/=]{40,}\s*\|\s*base64\s+(-d|--decode)/i),
  r("FS-EXE-005", "exec", "high", "A downloaded file made executable", "Downloads a program and prepares it to run.", /\b(curl|wget)\b[^\n]{0,200}(-o|-O|--output)\s*\S+[\s\S]{0,200}\bchmod\s+(\+x|[0-7]*7[0-7]{2})\b/i),
  r("FS-SEC-001", "secrets", "high", "Reads SSH private keys", "SSH private keys give access to servers and code.", /\b(cat|cp|scp|base64|read|readfile|readfilesync|open|type|less|more|tar|zip|get-content|upload)\b[^\n]{0,60}(~|\$HOME)?\/?\.ssh\/(id_[a-z0-9]+|identity)\b(?!\.pub)/i),
  r("FS-SEC-002", "secrets", "high", "Reads cloud or developer credentials", "These files hold long-lived access keys.", /\b(cat|cp|base64|read|readfile|readfilesync|open|type|less|more|tar|zip|get-content|upload|send)\b[^\n]{0,60}(\.aws\/credentials|\.config\/gcloud\/[^\s]*credentials|\.azure\/[^\s]*token|\.kube\/config|\.docker\/config\.json|\.npmrc|\.pypirc|\.git-credentials|\.netrc|\.config\/gh\/hosts\.yml)/i),
  r("FS-SEC-003", "secrets", "high", "Reads an agent's own key file", "An agent's .env or credentials file holds every API key it has (the most common skill theft target).", /\.(clawdbot|openclaw|moltbot|claude|cursor|codex|gemini)\/(\.env\b|credentials\b[^\s"'`]*|auth\.json\b)|(~|\$HOME|\$\{HOME\}|%USERPROFILE%)\/\.env\b/i),
  r("FS-SEC-009", "secrets", "medium", "Reads a key file inside a skill folder", "A skill reading its own .env is common; check nothing else reads it.", /\.(claude|openclaw|cursor|codex)\/skills\/[^\s"'`]*\.env\b/i),
  r("FS-SEC-007", "secrets", "medium", "Reads a .env file", "A .env file usually holds API keys; check where its contents go next.", /\b(cat|type|less|more|head|tail|readfile|readfilesync|get-content|source)\b[^\n]{0,60}(^|[\s"'`/])\.env\b(?!\.example|\.sample|\.template)/im),
  r("FS-SEC-004", "secrets", "high", "Reads crypto wallets or seed phrases", "Wallet files and seed phrases are enough to take the funds.", /\bwallet\.dat\b|\bkeystore\/[^\s]*\.json\b|Library\/Application Support\/(Exodus|Electrum|MetaMask)|\b(enter|paste|type|send|provide|export|read|copy|upload)\b[^\n.]{0,40}\b(seed|recovery|secret)\s+phrase\b|\b(enter|paste|type|send|provide|export)\b[^\n.]{0,30}\bmnemonic\b/i),
  r("FS-SEC-005", "secrets", "high", "Reads saved browser passwords", "Saved passwords sign in as you everywhere.", /(Chrome|Chromium|Brave|Edge|User Data|Default)[^\n]{0,40}\bLogin Data\b|\bkey4\.db\b|\blogins\.json\b|\bLocal State\b[^\n]{0,60}\bencrypted_key\b/),
  r("FS-SEC-010", "secrets", "medium", "Reads a secret from the system keychain", "Fine for a skill's own key; check which item it reads and where it goes.", /security\s+find-(generic|internet)-password/i),
  r("FS-SEC-008", "secrets", "medium", "Uses browser cookies", "Browser cookies carry signed-in sessions; check where they go.", /\b(cookies?)\b[^\n]{0,40}\b(Chrome|Chromium|Brave|Edge|Firefox|Safari)\b|\b(Chrome|Chromium|Brave|Edge|Firefox)\b[^\n]{0,40}\bcookies?\b/i),
  r("FS-SEC-006", "secrets", "medium", "Collects environment variables or tokens", "Dumping the environment exposes every key the agent holds.", /\b(printenv|env\s*\|\s*(curl|nc|base64)|process\.env\b[^\n]{0,40}(JSON\.stringify|fetch)|os\.environ\b[^\n]{0,40}(requests\.|json\.dumps|urllib))/i),
  r("FS-EXF-001", "exfil", "high", "Sends data to a throwaway collection endpoint", "Services like these are used to receive stolen data.", EXFIL_HOSTS),
  r("FS-EXF-003", "exfil", "medium", "Posts to a chat bot or tunnel", "Telegram, Discord webhooks and tunnels are common for alerts, and also for leaking data.", /\bapi\.telegram\.org\/bot|\bdiscord(app)?\.com\/api\/webhooks\b|\b[a-z0-9-]+\.ngrok(-free)?\.(app|io|dev)\b/i),
  r("FS-EXF-002", "exfil", "medium", "Uploads files or secrets to a remote server", "An upload of local files or keys leaves your machine.", /\bcurl\b[^\n]{0,200}(-F|--form|-T|--upload-file|--data-binary\s+@|-d\s+@)\s*\S*(\.env|\.ssh|credentials|id_rsa|\.pem|wallet|cookies)/i),
  r("FS-HID-001", "hidden", "high", "Hidden text in invisible characters", "Tag characters and runs of zero-width characters can carry instructions people can't see but models read (ASCII smuggling).", /[\u{E0020}-\u{E007E}]{2,}|[​-‍⁠-⁤]{3,}/u),
  r("FS-HID-004", "hidden", "medium", "An invisible character", "A single zero-width character is often harmless formatting, but worth a look.", /[​‎‏⁠-⁤]|(?<=[\x21-\x7E])‌|‌(?=[\x21-\x7E])|(?<=[\x21-\x7E])‍(?=[\x21-\x7E])|(?<!^)﻿/u),
  r("FS-HID-002", "hidden", "high", "Text-direction override characters", "Bidirectional controls make text display differently from what it says.", /[‪-‮⁦-⁩]/u),
  r("FS-HID-003", "hidden", "medium", "Instructions inside an HTML comment", "Comments are hidden when the file is rendered, but models still read them.", /<!--(?:(?!-->)[\s\S]){0,800}?\b(ignore|instruction|you must|do not tell|run|execute|curl|wget|send|upload|password|token|api key)\b(?:(?!-->)[\s\S]){0,800}?-->/i),
  r("FS-INJ-001", "injection", "medium", "An instruction to ignore earlier instructions", "The classic prompt-injection opening.", /\b(ignore|disregard|forget|override)\b[^\n]{0,30}\b(all\s+)?(previous|prior|above|earlier|preceding|system|your)\b[^\n]{0,20}\b(instructions?|prompts?|rules|guidelines|directives)\b/i),
  r("FS-INJ-002", "injection", "medium", "An instruction to keep something from the user", "A skill should never need to hide what it does.", /\b(do\s+not|don't|never|without)\b[^\n.!?]{0,20}\b(tell(ing)?|inform(ing)?|mention(ing)?|reveal(ing)?|notify(ing)?|alert(ing)?)\b[^\n.!?]{0,20}\b(the\s+)?(user|human|owner|operator)\b|\b(silently|secretly|covertly)\s+(run|send|upload|install|execute|delete|copy|exfiltrate|forward|post)\b/i),
  r("FS-INJ-003", "injection", "medium", "A fake system or role message", "Text pretending to be the system prompt or a new role.", /^\s*(\[|<)\s*(system|SYSTEM|assistant)\s*(\]|>)|\byou are now\b[^\n]{0,40}\b(in\s+)?(developer|admin|god|unrestricted|jailbreak|dan)\b|\bnew (system )?instructions:\s/im),
  r("FS-PER-001", "persistence", "medium", "Changes the agent's standing files or memory", "Writing to heartbeat, memory or instruction files makes a change outlive the task.", /\b(HEARTBEAT|AGENTS|CLAUDE|MEMORY|SOUL)\.md\b[^\n]{0,80}\b(append|add|write|edit|modify|insert|update)\b|\b(append|add|write|insert)\b[^\n]{0,60}\b(to|into)\b[^\n]{0,20}\b(HEARTBEAT|AGENTS|CLAUDE|MEMORY|SOUL)\.md\b|\badd (this|the following)\b[^\n]{0,40}\b(to )?(your )?(memory|system prompt|heartbeat|instructions)\b/i),
  r("FS-PER-002", "persistence", "medium", "Installs a scheduled task or shell start-up hook", "Runs again later without anyone asking.", /\bcrontab\s+(-e|-l\s*\|)|\/etc\/cron|\blaunchctl\s+(load|bootstrap)\b|LaunchAgents\/|\bschtasks\s+\/create\b|>>\s*~\/\.(bashrc|zshrc|profile|bash_profile)\b|systemctl\s+(--user\s+)?enable\b/i),
  r("FS-REM-001", "remote", "medium", "Fetches remote text and follows it", "Whoever controls that URL can change what your agent does at any time (the Moltbook heartbeat pattern).", /\b(fetch|curl|wget|download|read|load|get)\b[^\n]{0,80}https?:\/\/\S+\.(md|txt|json)\b[\s\S]{0,160}\b(follow|obey|execute|do what|carry out|apply)\b[^\n]{0,30}\b(it|them|instructions?|steps|says|tells)\b/i),
  r("FS-REM-002", "remote", "medium", "Re-fetches instructions on a timer", "A periodic fetch of instructions is a standing remote control.", /\bevery\s+\d+\s*(minutes?|mins?|hours?|hrs?|h)\b[\s\S]{0,200}\b(fetch|curl|wget|check|read)\b[^\n]{0,60}https?:\/\//i),
  r("FS-MON-001", "money", "medium", "Sends cryptocurrency to a fixed address", "A hard-coded payout address is a common scam pattern.", /\b(send|transfer|pay|deposit|withdraw)\b[^\n]{0,80}\b(0x[a-fA-F0-9]{40}|bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|T[A-Za-z1-9]{33})\b/),
  r("FS-DES-001", "destructive", "high", "Deletes the home or root directory", "Irreversible data loss.", /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*|~\/\*)(\s|$|["'`;])/i),
  r("FS-PRM-001", "permissions", "medium", "Turns off the agent's permission prompts", "Removes the human check on every later action.", /--dangerously-skip-permissions|\bbypassPermissions\b|--yolo\b|"defaultMode"\s*:\s*"bypassPermissions"|auto[-_ ]?approve[^\n]{0,20}\b(all|everything|true)\b/i),
  r("FS-PRM-002", "permissions", "low", "Asks for administrator rights", "sudo gives the command full control of the machine.", /\bsudo\s+(?!-v\b)[a-z]/i),
  r("FS-OBF-001", "obfuscation", "low", "A long encoded blob", "Long base64 or hex text can hide a payload from readers.", /[A-Za-z0-9+/]{240,}={0,2}|\b(?:[0-9a-fA-F]{2}){160,}\b/),
];

/** Lines that quote a pattern as a warning or an example ("never run rm -rf /", "an attacker might…"). */
const WARNING_CONTEXT = /\b(never|don't|do not|must not|avoid|block(ed|s)?|den(y|ied|ies)|forbid(den)?|refuse|reject|disallow(ed)?|dangerous|malicious|attacker|attack|exploit|payload|e\.g\.|for example|example of|such as|detect(s|ed|ion)?|flag(s|ged)?|warn(s|ing)?)\b/i;
const DOWNGRADE: Record<ScanSeverity, ScanSeverity> = { high: "medium", medium: "low", low: "low" };

export interface ScanFinding {
  rule: string;
  family: ScanFamily;
  severity: ScanSeverity;
  title: string;
  why: string;
  line: number;
  column: number;
  /** The matched text with invisible characters made visible, at most 160 characters. For people, not agents. */
  evidence: string;
  /** Set when the line reads as a warning or an example; the severity was lowered one step. */
  context?: "warning";
}

export interface ScanResult {
  verdict: ScanVerdict;
  fingerprint: string;
  bytes: number;
  lines: number;
  rules_version: string;
  findings: ScanFinding[];
  counts: Record<ScanSeverity, number>;
}

/** Makes invisible and direction-control characters visible, and trims. */
export function visible(s: string, max = 160): string {
  const out = s.replace(/[​-‏⁠-⁤﻿‪-‮⁦-⁩\u{E0000}-\u{E007F}]/gu, (ch) => `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`).replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** The fingerprint the Forge pins results to: sha256 of the text with line endings normalised to LF. */
export async function scanFingerprint(text: string): Promise<string> {
  const norm = text.replace(/\r\n?/g, "\n");
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm));
  return `sha256:${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const MAX_PER_RULE = 5;

/** Scans text. Every rule reports at most 5 places, so one noisy file can't bury the rest. */
export async function scanSkill(text: string): Promise<ScanResult> {
  const norm = text.replace(/\r\n?/g, "\n").slice(0, SCAN_MAX_BYTES);
  const starts = [0];
  for (let i = 0; i < norm.length; i++) if (norm[i] === "\n") starts.push(i + 1);
  const where = (idx: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= idx) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, column: idx - starts[lo]! + 1 };
  };
  const findings: ScanFinding[] = [];
  for (const rule of SCAN_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`);
    let n = 0;
    for (const m of norm.matchAll(re)) {
      if (n++ >= MAX_PER_RULE) break;
      const { line, column } = where(m.index ?? 0);
      const lineText = norm.slice(starts[line - 1], norm.indexOf("\n", starts[line - 1]) === -1 ? undefined : norm.indexOf("\n", starts[line - 1]));
      const warned = rule.family !== "hidden" && WARNING_CONTEXT.test(lineText);
      findings.push({ rule: rule.id, family: rule.family, severity: warned ? DOWNGRADE[rule.severity] : rule.severity, title: rule.title, why: rule.why, line, column, evidence: visible(m[0]), ...(warned ? { context: "warning" as const } : {}) });
    }
  }
  findings.sort((a, b) => sev(a.severity) - sev(b.severity) || a.line - b.line);
  const counts = { high: 0, medium: 0, low: 0 } as Record<ScanSeverity, number>;
  for (const f of findings) counts[f.severity]++;
  return {
    verdict: counts.high ? "flagged" : counts.medium ? "caution" : "clear",
    fingerprint: await scanFingerprint(text),
    bytes: new TextEncoder().encode(norm).length,
    lines: starts.length,
    rules_version: SCAN_RULES_VERSION,
    findings,
    counts,
  };
}

const sev = (s: ScanSeverity) => (s === "high" ? 0 : s === "medium" ? 1 : 2);

/** Plain-English one-liner for a result (for people). */
export function scanSummary(r: Pick<ScanResult, "verdict" | "counts">): string {
  if (r.verdict === "flagged") return `Flagged: ${r.counts.high} high-risk pattern${r.counts.high === 1 ? "" : "s"} found. Don't install it until a person has read the flagged lines.`;
  if (r.verdict === "caution") return `Caution: ${r.counts.medium} pattern${r.counts.medium === 1 ? "" : "s"} worth a look before installing.`;
  return "No known risky patterns found. That isn't a guarantee: read what it asks your agent to do.";
}
