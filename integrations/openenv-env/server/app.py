"""FastAPI app for the Forge Arena dev-split environment (OpenEnv `create_app`).

Endpoints (OpenEnv's): POST /reset, POST /step, GET /state, GET /schema, GET /metadata, GET /health, WS /ws for
episodes (HTTP /reset and /step are stateless; a multi-step episode runs over the WebSocket, as EnvClient does), and
the Task API under /forge_arena_env/ (splits, tasks, num_tasks, task, task_range).

Run: uvicorn server.app:app --host 0.0.0.0 --port 8000   (or: uv run --project . server)
"""

try:
    from openenv.core.env_server.http_server import create_app
except Exception as e:  # pragma: no cover
    raise ImportError("openenv is required. Install dependencies with 'uv sync'.") from e

try:
    from ..models import ForgeArenaAction, ForgeArenaObservation, ForgeArenaState
    from .forge_arena_environment import ForgeArenaEnvironment
except ImportError:
    from models import ForgeArenaAction, ForgeArenaObservation, ForgeArenaState
    from server.forge_arena_environment import ForgeArenaEnvironment

app = create_app(
    ForgeArenaEnvironment,
    ForgeArenaAction,
    ForgeArenaObservation,
    env_name="forge_arena_env",
    max_concurrent_envs=16,
    state_cls=ForgeArenaState,
)


def main():
    """Entry point for `uv run --project . server` or `python -m forge_arena_env.server.app`."""
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
