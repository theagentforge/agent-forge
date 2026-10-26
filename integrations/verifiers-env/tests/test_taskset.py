"""The Verifiers taskset loads the dev split and its gold check passes (needs verifiers 0.4; skipped without it).

A full rollout needs a model endpoint; that was checked by hand with a scripted model (README: Run it).
"""

import asyncio
import importlib.util
import unittest

HAS_VF = importlib.util.find_spec("verifiers") is not None


@unittest.skipUnless(HAS_VF, "verifiers isn't installed")
class Taskset(unittest.TestCase):
    def test_loads_thirty_tasks_whose_reference_passes(self) -> None:
        from forge_arena_dev import ForgeArenaDevTaskset
        from forge_arena_dev.taskset import ForgeArenaDevConfig

        tasks = list(ForgeArenaDevTaskset(ForgeArenaDevConfig()))
        self.assertEqual(len(tasks), 30)
        self.assertEqual(len({t.key for t in tasks}), 30)
        for t in tasks:
            self.assertTrue(asyncio.run(t.validate(None)))
            self.assertIn("finish", [x["name"] for x in t.data.reference])
        only = list(ForgeArenaDevTaskset(ForgeArenaDevConfig(jobs=["refund"])))
        self.assertEqual({t.data.job for t in only}, {"refund"})


if __name__ == "__main__":
    unittest.main()
