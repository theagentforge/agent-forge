import { describe, expect, it } from "vitest";
import { installTargets, npmName, shellWords } from "../src/install-parse";

describe("install command parsing", () => {
  it.each([
    ["npm install express", ["npm:express"]],
    ["npm i -D @types/node typescript@5", ["npm:@types/node", "npm:typescript"]],
    ["pnpm add @scope/pkg@latest", ["npm:@scope/pkg"]],
    ["yarn add left-pad", ["npm:left-pad"]],
    ["bun add zod", ["npm:zod"]],
    ["npx -y @modelcontextprotocol/server-filesystem /tmp", ["npm:@modelcontextprotocol/server-filesystem"]],
    ["npx --package=cowsay cowsay hi", ["npm:cowsay"]],
    ["pnpm dlx create-vite my-app", ["npm:create-vite"]],
    ["bunx prettier .", ["npm:prettier"]],
    ["cd app && npm install lodash && npm test", ["npm:lodash"]],
    ["sudo npm install -g some-cli", ["npm:some-cli"]],
    ["FOO=1 npm i dotenv", ["npm:dotenv"]],
    ["git clone https://github.com/Acme/Skills.git", ["github.com/acme/skills"]],
    ["git clone --depth 1 git@github.com:acme/tools", ["github.com/acme/tools"]],
    ["claude mcp add fs -- npx -y @acme/fs-mcp", ["npm:@acme/fs-mcp"]],
    ['npm install "@quoted/pkg"', ["npm:@quoted/pkg"]],
  ])("%s", (cmd, ids) => {
    expect(installTargets(cmd)).toEqual(ids);
  });

  it.each([
    "npm install",
    "pnpm install --frozen-lockfile",
    "npm test",
    "npm install ./local-folder",
    "npm install file:../x",
    "npm install https://example.com/x.tgz",
    "npm install owner/repo",
    "ls -la",
    "echo npm install evil",
    "git clone https://gitlab.com/a/b",
  ])("ignores %s", (cmd) => {
    expect(installTargets(cmd)).toEqual([]);
  });

  it("caps the number of checks", () => {
    expect(installTargets(`npm i ${Array.from({ length: 20 }, (_, i) => `p${i}`).join(" ")}`)).toHaveLength(8);
  });

  it("npm names", () => {
    expect(npmName("@a/b@^1")).toBe("@a/b");
    expect(npmName("-D")).toBeNull();
    expect(shellWords(`a "b c" 'd'`)).toEqual(["a", "b c", "d"]);
  });
});
