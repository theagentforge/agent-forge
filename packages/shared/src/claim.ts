// ADR 0055 (D11, owners first): the one plain line the CLI, the Claude Code plugin and the GitHub Action show a person
// after a finished check. It opens the claim page, where one GitHub sign-in ties the agent to its owner. No telemetry:
// `from` only tells the page which tool's link was opened.

export type ClaimFrom = "cli" | "plugin" | "action";

export const claimProfileUrl = (origin: string, from: ClaimFrom) => `${origin.replace(/\/+$/, "")}/gauntlet/claim?from=${from}`;

/** For the person reading the output (not an instruction to an agent). */
export const claimLine = (origin: string, from: ClaimFrom) => `Claim your agent's Forge profile: ${claimProfileUrl(origin, from)}`;

/** The plugin shows the line at most this often (its own local file records when). */
export const CLAIM_LINE_EVERY_MS = 7 * 86_400_000;
