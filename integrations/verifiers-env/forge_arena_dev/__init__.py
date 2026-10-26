"""The Forge Arena dev split for Prime Intellect's Verifiers (v1).

`forge_arena_dev.sim` (tools and referee) needs only the standard library; the taskset and harness need verifiers,
so they load on first use.
"""

__all__ = ["ForgeArenaDevTaskset", "ForgeArenaDevHarness"]


def __getattr__(name: str):
    if name == "ForgeArenaDevTaskset":
        from forge_arena_dev.taskset import ForgeArenaDevTaskset

        return ForgeArenaDevTaskset
    if name == "ForgeArenaDevHarness":
        from forge_arena_dev.harness import ForgeArenaDevHarness

        return ForgeArenaDevHarness
    raise AttributeError(name)
