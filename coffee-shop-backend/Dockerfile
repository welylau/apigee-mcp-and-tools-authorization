# Pinned tag (not floating 3.11-slim) so rebuilds are reproducible.
FROM python:3.11.14-slim-bookworm

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py auth.py ./

# Run as an unprivileged user.
RUN useradd --system --uid 10001 --no-create-home app
USER 10001

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
