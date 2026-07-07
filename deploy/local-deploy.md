# Local deployment

`ops-deploy.sh` is the repeatable local deployment entry for the target host.
It deploys `backend`, `admin`, and `portal` under
`/home/gsg/workspace/project/homelab` using direct code deployment: it installs
dependencies, builds the apps, and runs them as local processes managed by
`start-stop-daemon`. The existing Docker image release path
(`deploy/Dockerfile` plus `.github/workflows/tag-image.yml`) is kept separate and
is not used by the automatic deployment flow.

## Target contract

- Source checkout: `/home/gsg/workspace/project/homelab/source`
- Runtime files: `/home/gsg/workspace/project/homelab/deploy`
- Env file: `/home/gsg/workspace/project/homelab/deploy/.env`
- Pid files: `/home/gsg/workspace/project/homelab/deploy/pids/*.pid`
- Service logs: `/home/gsg/workspace/project/homelab/deploy/logs/*.log`
- Backend: `http://127.0.0.1:3000`, public `https://home.gfun.vip:8323/health`
- Admin: `http://127.0.0.1:3002`, public `https://home.gfun.vip:8322/login`
- Portal: `http://127.0.0.1:3001`, public `https://home.gfun.vip:8321/`
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

## Safety gates

- The script checks `git`, `pnpm`, `node`, `curl`, `start-stop-daemon`, the nginx
  container, and the required env keys before build/start.
- The admin app receives `ADMIN_BACKEND_URL` during build because Next.js
  rewrites are compiled into the production server.
- Prisma migrations are skipped by default because Stage 1 found an existing
  database without `_prisma_migrations`. To run migrations, both flags are
  required:

```bash
HOMELAB_RUN_PRISMA_MIGRATE=1 \
HOMELAB_PRISMA_BASELINE_CONFIRMED=1 \
./ops-deploy.sh
```

- nginx registration writes `/home/gsg/workspace/app/nginx/config/homelab.conf`.
  It only runs `nginx -t` and reloads/restarts when the generated config has
  changed compared to the existing managed file. This avoids touching nginx on
  every code deployment.
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
