# ADK dev server for both agents (coffee_agent_prod, coffee_agent_staff).
# Pinned base tag for reproducible rebuilds.
FROM python:3.13.8-slim-bookworm

WORKDIR /app

# Only google-adk is used (MCP toolset, callbacks, `adk web`); a2a-sdk and the
# [agent-identity] extra were never imported. Version matches uv.lock.
RUN pip install --no-cache-dir "google-adk==1.39.1"

# Run as an unprivileged user; it owns the agents dir (ADK may write .adk/).
RUN useradd --system --uid 10001 --create-home app
COPY --chown=10001:10001 python/agents /app/agents
USER 10001

WORKDIR /app/agents

ENV PYTHONUNBUFFERED=1
ENV PORT=8080
# Browser origins allowed to call the ADK API directly (comma-free single
# origin, or empty = same-origin only). The web UIs call ADK server-side, so
# the default is empty; never '*'.
ENV ALLOW_ORIGINS=""

EXPOSE 8080

CMD ["sh", "-c", "exec adk web --host 0.0.0.0 --port ${PORT} ${ALLOW_ORIGINS:+--allow_origins \"$ALLOW_ORIGINS\"} --session_service_uri memory:// --artifact_service_uri memory:// ."]
