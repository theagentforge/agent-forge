"""The default harness for this taskset: verifiers' plain chat loop with the job's MCP tools and nothing else.

The Arena gives a model only the job's tools (no shell, no code execution), so the dev split does the same. It is
verifiers' `null` harness under this package's name, so `vf-eval forge-arena-dev` picks it without a flag.
"""

from verifiers.v1.harnesses.null.harness import NullHarness


class ForgeArenaDevHarness(NullHarness):
    pass
