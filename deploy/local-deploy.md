# Local deployment

`ops-deploy.sh` is the repeatable local deployment entry for the target host.
It deploys `backend`, `admin`, and `portal` under
`/home/gsg/workspace/project/homelab` and keeps the existing Docker image
release path (`deploy/Dockerfile` plus `.github/workflows/tag-image.yml`)
separate.

## Target contract

- Source checkout: `/home/gsg/workspace/project/homelab/source`
- Runtime files: `/home/gsg/workspace/project/homelab/deploy`
- Env file: `/home/gsg/workspace/project/homelab/deploy/.env`
- Docker network: external `wg_br0`
- Backend: `homelab-backend`, `192.168.52.22:3000`, public
  `https://home.gfun.vip:8323/health`
- Admin: `homelab-admin`, `192.168.52.23:3002`, public
  `https://home.gfun.vip:8322/login`
- Portal: `homelab-portal`, `192.168.52.24:3000`, public
  `https://home.gfun.vip:8321/`
- Admin backend rewrite probe:
  `https://home.gfun.vip:8322/api/backend/health`

## Usage

```bash
./ops-deploy.sh --check-only
./ops-deploy.sh
```

On first run the script creates
`/home/gsg/workspace/project/homelab/deploy/.env` from
`deploy/env.local.example` and exits non-zero. Fill the real target values or set
`HOMELAB_ENV_SOURCE=/path/to/existing/.env` before rerunning. Secrets must stay
on the target host and must not be committed.

Common overrides:

```bash
HOMELAB_GIT_REF=main ./ops-deploy.sh
HOMELAB_ENV_SOURCE=/git/vps-config/app/homelab/.env ./ops-deploy.sh
HOMELAB_PROJECT_ROOT=/home/gsg/workspace/project/homelab ./ops-deploy.sh
```

## GitHub Actions remote deploy

`.github/workflows/post-commit-deploy.yml` runs the deploy job on
`ubuntu-latest` and connects to the target host over SSH. The workflow syncs the
target checkout to the exact commit SHA being deployed, runs
`./ops-deploy.sh --skip-git` on the target, then copies
`deploy-result.json` and `deploy.log` back into the GitHub Actions artifact.

Required repository configuration:

- Secret `HOMELAB_DEPLOY_SSH_KEY`: private key allowed to SSH to the target host.
- Secret `HOMELAB_DEPLOY_SSH_KNOWN_HOSTS`: optional pinned SSH host key. If it is
  absent, the workflow uses `ssh-keyscan` for the configured host.
- Variable `HOMELAB_DEPLOY_SSH_HOST`: target host, defaults to `home.gfun.vip`.
- Variable `HOMELAB_DEPLOY_SSH_USER`: target user, defaults to `gsg`.
- Variable `HOMELAB_DEPLOY_SSH_PORT`: target SSH port, defaults to `22`.

## Safety gates

- The script checks `git`, Docker Compose v2, `curl`, the nginx container, and
  the required env keys before build/start.
- App dependencies are installed inside Docker builds; the target host does not
  need `pnpm`.
- The admin image receives `ADMIN_BACKEND_URL` during Docker build because
  Next.js rewrites are compiled into the production server.
- Prisma migrations are skipped by default because Stage 1 found an existing
  database without `_prisma_migrations`. To run migrations, both flags are
  required:

```bash
HOMELAB_RUN_PRISMA_MIGRATE=1 \
HOMELAB_PRISMA_BASELINE_CONFIRMED=1 \
./ops-deploy.sh
```

- nginx registration writes `/home/gsg/workspace/app/nginx/config/homelab.conf`
  unless the existing `default.conf` already owns all three Homelab ports. It
  runs `nginx -t` before reload/restart.
- Every deployment writes a QA-readable JSON result to
  `/home/gsg/workspace/project/homelab/deploy/deploy-result.json`, or to
  `HOMELAB_DEPLOY_RESULT_FILE` when that override is set.
- A failed stage exits non-zero, prints the failed stage name, and writes the
  failure stage plus summary into the deploy result file.

## Successful output

The final summary prints QA-accessible URLs:

```text
portal:  https://home.gfun.vip:8321/
admin:   https://home.gfun.vip:8322/login
backend: https://home.gfun.vip:8323/health
rewrite: https://home.gfun.vip:8322/api/backend/health
```

The result file stores the deployed ref, resolved commit SHA, status, trigger
metadata, and the same QA URLs. The post-commit deploy workflow uploads that
file as the `homelab-deploy-result` artifact and only starts the QA E2E handoff
job when the deploy job succeeds with `"status": "success"`.
