FROM python:3.13.5-slim-bookworm@sha256:4c2cf9917bd1cbacc5e9b07320025bdb7cdf2df7b0ceaccb55e9dd7e30987419

WORKDIR /app

# Exact version the agents are tested with locally. Nothing else is needed:
# a2a-sdk and the agent-identity extra are unused by both agents and the BFF.
RUN pip install --no-cache-dir "google-adk==1.32.0"

# Run as an unprivileged user. It owns /app because ADK may create local state
# (e.g. agents/<app>/.adk) next to the agents; sessions themselves are in memory.
RUN useradd --system --uid 10001 --create-home --home-dir /home/app app

COPY --chown=app:app . /app

ENV PYTHONUNBUFFERED=1
ENV PORT=8080
ENV HOST=0.0.0.0

USER app

EXPOSE 8080

CMD ["python3", "server.py"]
