import { describe, expect, it } from "vitest";
import { checkParams, idsInWords, installRefs, installTargets, npmName, npmSpec, pySpec, shellWords } from "../src/install-parse";

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

describe("pinned versions and Python installs", () => {
  it.each([
    ["npm i some-pkg@1.2.3", [{ id: "npm:some-pkg", version: "1.2.3" }]],
    ["pnpm add @s/n@1.2.3-beta.1", [{ id: "npm:@s/n", version: "1.2.3-beta.1" }]],
    ["npx -y @acme/mcp@0.4.0 --stdio", [{ id: "npm:@acme/mcp", version: "0.4.0" }]],
    ["npm i a@^1.2.3 b@latest c@1 d", [{ id: "npm:a" }, { id: "npm:b" }, { id: "npm:c" }, { id: "npm:d" }]],
    ["pip install litellm==1.107.0", [{ id: "pypi:litellm", version: "1.107.0" }]],
    ["pip3 install -U Foo_Bar[extra]==2.0rc1 requests", [{ id: "pypi:foo-bar", version: "2.0rc1" }, { id: "pypi:requests" }]],
    ["python -m pip install 'django>=4' -r requirements.txt", [{ id: "pypi:django" }]],
    ["uv add litellm==1.107.0 httpx", [{ id: "pypi:litellm", version: "1.107.0" }, { id: "pypi:httpx" }]],
    ["uv pip install --index-url https://x.example/simple litellm===1.107.0", [{ id: "pypi:litellm", version: "1.107.0" }]],
    ["uvx mcp-server-fetch", [{ id: "pypi:mcp-server-fetch" }]],
    ["uvx ruff@0.6.0 check .", [{ id: "pypi:ruff", version: "0.6.0" }]],
    ["uvx --from mcp-server-git==0.6.2 mcp-server-git", [{ id: "pypi:mcp-server-git", version: "0.6.2" }]],
    ["uv tool install black", [{ id: "pypi:black" }]],
    ["pipx install poetry==1.8.3", [{ id: "pypi:poetry", version: "1.8.3" }]],
    ["pipx run --spec cowsay==6.1 cowsay hi", [{ id: "pypi:cowsay", version: "6.1" }]],
    ["claude mcp add fetch -- uvx mcp-server-fetch", [{ id: "pypi:mcp-server-fetch" }]],
  ])("%s", (cmd, refs) => {
    expect(installRefs(cmd)).toEqual(refs);
  });

  it.each([
    "pip install -r requirements.txt",
    "pip install -e .",
    "pip install ./dist/pkg-1.0-py3-none-any.whl",
    "pip install git+https://github.com/a/b",
    "pip list",
    "uv sync",
    "uv run pytest",
    "pipx list",
  ])("ignores %s", (cmd) => {
    expect(installRefs(cmd)).toEqual([]);
  });

  it("keeps the name when the version is a range, and checks a pinned and an unpinned install separately", () => {
    expect(pySpec("pkg~=1.4")).toEqual({ name: "pkg" });
    expect(pySpec("pkg==1.0.*")).toEqual({ name: "pkg" });
    expect(npmSpec("@a/b@=1.0.0")).toEqual({ name: "@a/b", version: "1.0.0" });
    expect(installRefs("npm i x@1.0.0 && npm i x")).toEqual([{ id: "npm:x", version: "1.0.0" }, { id: "npm:x" }]);
    expect(installTargets("npm i x@1.0.0 && npm i x")).toEqual(["npm:x"]);
  });

  it("builds the check query, with the version only when pinned", () => {
    expect(checkParams({ id: "pypi:litellm", version: "1.107.0" }).toString()).toBe("id=pypi%3Alitellm&version=1.107.0");
    expect(checkParams({ id: "pypi:litellm" }).toString()).toBe("id=pypi%3Alitellm");
  });

  it("leaves Python packages out of the GitHub Action's ids", () => {
    expect(idsInWords(["uvx", "mcp-server-fetch"])).toEqual([]);
    expect(idsInWords(["npx", "-y", "@acme/mcp@1.0.0"])).toEqual(["npm:@acme/mcp"]);
  });
});
