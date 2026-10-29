# The Forge Arena dev split, OpenEnv server image (OpenEnv's environment template, adapted).
#
# The build context is integrations/, not this folder: the image needs the shared tools-and-referee port from
# integrations/verifiers-env/forge_arena_dev as well as this environment (server/Dockerfile.dockerignore sends only
# those two). From the repo root:
#   docker build -t forge-arena-env:0.1.0 -f integrations/openenv-env/server/Dockerfile integrations
#   docker run --rm -p 8000:8000 forge-arena-env:0.1.0

ARG BASE_IMAGE=ghcr.io/huggingface/openenv-base:latest
FROM ${BASE_IMAGE} AS builder

WORKDIR /app/env
COPY openenv-env/ /app/env/
COPY verifiers-env/forge_arena_dev/ /app/env/forge_arena_dev/

RUN if ! command -v uv >/dev/null 2>&1; then \
        curl -LsSf https://astral.sh/uv/install.sh | sh && \
        mv /root/.local/bin/uv /usr/local/bin/uv; \
    fi

# Dependencies only (openenv), from the lock file; the code runs from /app/env.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-editable && \
    mv /app/env/.venv /app/.venv

FROM ${BASE_IMAGE}

WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/env /app/env

ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH="/app/env"

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["sh", "-c", "cd /app/env && uvicorn server.app:app --host 0.0.0.0 --port 8000"]
