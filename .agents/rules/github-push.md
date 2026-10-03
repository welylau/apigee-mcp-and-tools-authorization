---
trigger: model_decision
description: "Use when committing, pushing, or opening a PR to GitHub from this repository. Defines the mandatory sanitize/restore workflow that keeps real credentials out of git."
---

# GitHub push workflow (mandatory)

Real local values (Keycloak client secret, Keycloak admin password, GCP project
ID/number, Keycloak IP) live in working files. They must be masked before
anything is committed and restored afterwards.

## Steps
1. Run `./sanitize.sh --check` and report which files hold real values.
2. With the user, agree what to stage:
   - Include new files that deploys depend on (proxy policies, `resources/jsc/*`, web-ui modules).
   - Ask about dev-only or one-off files (`scripts/deploy-*-dev.sh`, `test-*.py`, `generate_*.py`).
   - Never stage files containing local absolute paths (e.g. `/Users/...`).
3. Run `./sanitize.sh`. Its leak check must report 0 before you continue.
4. Review the staged diff:
   - No secrets, and no values `sanitize.sh` doesn't mask (Apigee IPs, `*.nip.io` hosts, `/Users/` paths).
   - Nothing that should stay local is staged: `.env`, `web-ui/.env`, `.secrets_map.json`, `sanitize.sh`, `restore.sh`.
5. Commit and push with the `git-update` skill (one confirmation per step). Ask the user for the commit message.
   - New branches: `git push -u origin <branch>`.
   - Never merge into `main` or force-push unless explicitly asked.
6. Run `./restore.sh` right after pushing; deploy scripts need the real values.
7. Confirm `git status` is clean and the deploy scripts show real values again.

## History check
Before the first push of a branch, check whether local commits not yet on
`origin` contain secrets (`git log origin/main..HEAD -S <value>`). If they do,
stop: tell the user and recommend rotating the secret or rewriting those
commits. `sanitize.sh` cleans only the current files, not history.
