import { html } from "hono/html";

// How a reader runs `forge verify` (ADR 0066). The verify command first shipped in @theagentforge/cli 0.5.0, published
// to npm on 28 Oct 2026, so pages show the npx line. (Before that they gave the from-source steps; keep the switch so a
// future CLI that adds a command can follow the same path.)
export const VERIFY_ON_NPM = true;
// ADR 0084: 0.5.0 can rebuild the wrong sandbox for refund, scam-invoice and weekend replays (an engine-dependent shuffle),
// so it can report those as FAILED. 0.5.1 fixed it. B3-09 (ADR 0103): CLI 0.6.0 adds the install ID; verify is
// unchanged. ADR 0119: CLI 0.7.0 adds `setup`; verify is unchanged. test/dataset-sample.test.ts ties this to
// packages/cli/package.json, so it names 0.7.0: publish 0.7.0 (tag cli-v0.7.0) before the next production release,
// or the pages' npx line names a version npm doesn't have yet.
export const VERIFY_CLI_VERSION = "0.7.0";
export const PUBLIC_REPO = "https://github.com/theagentforge/agent-forge";

/** The command that verifies `target`, as a reader can run it today. */
export const verifyCommand = (target: string) =>
  VERIFY_ON_NPM ? `npx @theagentforge/cli@${VERIFY_CLI_VERSION} verify ${target}` : `node packages/cli/dist/cli.mjs verify ${target}`;

/** One sentence (HTML) on how to check a replay, with the command for `target`. */
export const verifyHowTo = (target: string) =>
  VERIFY_ON_NPM
    ? html`Check it yourself: <code>${verifyCommand(target)}</code>`
    : html`Check it yourself from the open code (the npm release with <code>verify</code>, CLI ${VERIFY_CLI_VERSION}, isn't published yet): clone <a href="${PUBLIC_REPO}">${PUBLIC_REPO.replace("https://", "")}</a>, run <code>pnpm install &amp;&amp; pnpm --filter @theagentforge/cli build</code>, then <code>${verifyCommand(target)}</code>`;
