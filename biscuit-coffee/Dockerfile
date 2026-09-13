FROM python:3.13-slim

WORKDIR /app

RUN pip install --no-cache-dir "google-adk[agent-identity]>=1.32.0,<2.0.0" "a2a-sdk>=0.3.4,<0.4.0"

COPY python/agents /app/agents

WORKDIR /app/agents

ENV PYTHONUNBUFFERED=1
ENV PORT=8080

EXPOSE 8080

CMD ["sh", "-c", "adk web --host 0.0.0.0 --port ${PORT} --allow_origins '*' --session_service_uri memory:// --artifact_service_uri memory:// ."]
