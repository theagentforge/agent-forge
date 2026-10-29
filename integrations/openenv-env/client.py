"""Forge Arena dev-split environment client (a persistent WebSocket session per client)."""

from typing import Any, Dict

from openenv.core import EnvClient
from openenv.core.client_types import StepResult

from .models import ForgeArenaAction, ForgeArenaObservation, ForgeArenaState

_OBS_FIELDS = ("task_id", "job", "seed", "system_prompt", "brief", "tools", "max_tool_calls", "tool", "ok", "result", "tool_calls", "verdict")


class ForgeArenaEnv(EnvClient[ForgeArenaAction, ForgeArenaObservation, ForgeArenaState]):
    """
    Example:
        >>> with ForgeArenaEnv(base_url="http://localhost:8000").sync() as env:
        ...     r = env.reset(task_id="refund-900001")
        ...     print(r.observation.brief, [t["name"] for t in r.observation.tools])
        ...     r = env.step(ForgeArenaAction(tool="get_policy"))
        ...     r = env.step(ForgeArenaAction(tool="finish", arguments={"status": "done", "summary": "..."}))
        ...     print(r.reward, r.observation.verdict)
    """

    def _step_payload(self, action: ForgeArenaAction) -> Dict[str, Any]:
        return {"tool": action.tool, "arguments": action.arguments}

    def _parse_result(self, payload: Dict[str, Any]) -> StepResult[ForgeArenaObservation]:
        obs = payload.get("observation", {})
        observation = ForgeArenaObservation(
            **{k: obs[k] for k in _OBS_FIELDS if k in obs},
            done=payload.get("done", False),
            reward=payload.get("reward"),
            metadata=payload.get("metadata") or obs.get("metadata", {}),
        )
        return StepResult(observation=observation, reward=payload.get("reward"), done=payload.get("done", False), metadata=payload.get("metadata"))

    def _parse_state(self, payload: Dict[str, Any]) -> ForgeArenaState:
        return ForgeArenaState(**payload)
