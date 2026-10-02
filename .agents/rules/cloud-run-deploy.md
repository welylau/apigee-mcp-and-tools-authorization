---
trigger: model_decision
description: "Use when deploying this repo's services to Cloud Run (scripts/deploy-backend.sh, deploy-ui.sh, deploy-adk.sh) or changing their env vars, secrets, Dockerfiles or .dockerignore files."
---

# Cloud Run deployment guardrails

## Config sources
- `web-ui/.env` is the source of truth for the UI's plain env vars.
  `scripts/deploy-ui.sh` sends it with `--env-vars-file`, which REPLACES the
  service's plain env vars on every deploy. It is excluded from the image by
  `web-ui/.dockerignore`.
- Secrets never go in code, `web-ui/.env` or images. `KEYCLOAK_CLIENT_SECRET`
  comes from Secret Manager secret `keycloak-client-secret` (mounted by
  `deploy-ui.sh`). For local runs it lives in the gitignored repo-root `.env`.
- New secrets: create them in Secret Manager, grant the runtime service account
  `roles/secretmanager.secretAccessor` on that secret only, mount with
  `--update-secrets`.
- Region comes from `GOOGLE_CLOUD_REGION` (default `asia-southeast1`), not
  `GOOGLE_CLOUD_LOCATION`.

## Before deploying
1. Say which services, project and region will be deployed, and get confirmation.
2. Read the live service config (`gcloud run services describe`) and compare
   its env vars with `web-ui/.env`. If they differ, ask which values to use.
3. Record each service's current ready revision as the rollback point.
4. Before excluding or deleting a config file, grep for code that reads it
   at runtime (`load_dotenv`, `open(".env")`, `os.environ`).

## After deploying
- Backend: an unauthenticated request must return HTTP 403.
- UI: IAP stays enabled (302 to Google login for anonymous requests). Startup
  logs must not show the `KEYCLOAK_CLIENT_SECRET is not set` warning.
- Report the new revisions and the rollback command.
