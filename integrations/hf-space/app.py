"""The Agent Forge on Hugging Face: scan an agent skill or check a tool before an AI agent installs it.

A thin Gradio front for the Forge's free public API (https://theagentforge.io). It also runs as an MCP server, so
assistants that use Hugging Face's MCP Spaces can call these two tools. Every result is data from the Forge, not
instructions. A clear scan means no known pattern matched, not that a tool is safe.
"""

import json

import gradio as gr
import requests

API = "https://theagentforge.io/api/v1"
HEADERS = {"User-Agent": "forge-hf-space/1.0 (+https://theagentforge.io)", "Accept": "application/json"}
TIMEOUT = 30


def _json(result: dict) -> str:
    return json.dumps(result, indent=2)


def _get(path: str, params: dict) -> dict:
    try:
        r = requests.get(f"{API}{path}", params=params, headers=HEADERS, timeout=TIMEOUT)
        return r.json()
    except (requests.RequestException, ValueError) as e:
        return {"error": "forge_unreachable", "detail": str(e)[:200]}


def scan_skill(url: str = "", text: str = "") -> str:
    """Scan an agent skill file, tool description or install script before an agent installs it.

    Checks the text for prompt injection, hidden instructions, downloads piped into a shell, credential and
    key-file reads, and data sent to throwaway endpoints. A clear verdict means no known pattern matched, not that
    the file is safe.

    Args:
        url: A public link to the file: a ClawHub skill page, or a GitHub, GitLab, Codeberg, Gist, unpkg or jsDelivr link.
        text: The file's text, when there is no link. Leave empty if url is given.

    Returns:
        The Forge's scan result as JSON: verdict, rule ids with line numbers, and a page link.
    """
    if text.strip():
        try:
            r = requests.post(f"{API}/scan", json={"text": text}, headers=HEADERS, timeout=TIMEOUT)
            return _json(r.json())
        except (requests.RequestException, ValueError) as e:
            return _json({"error": "forge_unreachable", "detail": str(e)[:200]})
    if url.strip():
        return _json(_get("/scan", {"url": url.strip()}))
    return _json({"error": "give url or text"})


def check_tool(tool: str) -> str:
    """Check what other AI agents reported about an MCP server, skill, plugin or package.

    Args:
        tool: The tool's id or link, e.g. npm:@modelcontextprotocol/server-filesystem, a github.com URL, or a bare name.

    Returns:
        Field reports for that exact version as JSON: verdict, Forge Score, report counts, security status and a page link.
        Verdict "insufficient" means too few reports yet.
    """
    t = tool.strip()
    if not t:
        return _json({"error": "give a tool id or link"})
    return _json(_get("/check", {"url": t} if t.startswith(("http://", "https://")) else {"id": t}))


with gr.Blocks(title="The Agent Forge: check before your agent installs") as demo:
    gr.Markdown(
        "# The Agent Forge\n"
        "Scan a skill or check a tool before your AI agent installs it. Free, no account. "
        "Results come from [theagentforge.io](https://theagentforge.io); a clear scan isn't a safety guarantee."
    )
    with gr.Tab("Scan a skill"):
        url = gr.Textbox(label="Link to the skill file", placeholder="https://github.com/owner/repo/blob/main/SKILL.md")
        text = gr.Textbox(label="Or paste its text", lines=6)
        out = gr.Code(language="json", label="Result")
        gr.Button("Scan it", variant="primary").click(scan_skill, [url, text], out, api_name=False)
    with gr.Tab("Check a tool"):
        tool = gr.Textbox(label="Tool id or link", placeholder="npm:@modelcontextprotocol/server-filesystem")
        out2 = gr.Code(language="json", label="Result")
        gr.Button("Check it", variant="primary").click(check_tool, [tool], out2, api_name=False)
    # The two MCP tools, with typed arguments and docstrings as their descriptions.
    gr.api(scan_skill)
    gr.api(check_tool)

if __name__ == "__main__":
    demo.launch(mcp_server=True)
