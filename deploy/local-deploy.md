# Local deployment

`deploy.sh` is the stable local deployment entry for the target host. It
delegates to `ops-deploy.sh`, which performs the actual source sync, build,
systemd restart, nginx reload, log inspection, public health check, and result
writeback.

The deployment is a bare-metal direct-code path. It does not require Docker for
the Homelab application services and it does not change the existing GHCR image
publishing path (`deploy/Dockerfile` plus `.github/workflows/tag-image.yml`).
Docker is still required because nginx currently runs in an existing container.

## Target contract

- Project root: `/home/gsg/workspace/project/homelab`
- Source checkout: `/home/gsg/workspace/project/homelab/source`
- Runtime files: `/home/gsg/workspace/project/homelab/deploy`
- Env file: `/home/gsg/workspace/project/homelab/deploy/.env`
- Logs: `/home/gsg/workspace/project/homelab/deploy/logs`
- systemd user units: `$HOME/.config/systemd/user/homelab-*.service`
- nginx config directory: `/home/gsg/workspace/app/nginx/config`
- nginx container: `nginx`

Services:

| Unit | Package | Start command | Port | Public URL |
| --- | --- | --- | --- | --- |
| `homelab-backend` | `@homelab/backend` | `pnpm --filter @homelab/backend start` | `3005` | `https://home.gfun.vip:8323/health` |
| `homelab-admin` | `@homelab/admin` | `pnpm --filter @homelab/admin exec next start -p 3006` | `3006` | `https://home.gfun.vip:8322/login` |
| `homelab-portal` | `@homelab/portal` | `pnpm --filter @homelab/portal exec next start -p 3007` | `3007` | `https://home.gfun.vip:8321/` |

Admin backend rewrite probe:
`https://home.gfun.vip:8322/api/backend/health`.

## Usage

```bash
./deploy.sh --check-only
./deploy.sh
```

Equivalent Make targets:

```bash
make ops-deploy-check
make ops-deploy
```

The script requires Bash 4+. It also includes a local self-test for log rotation
handling:

```bash
./deploy.sh --self-test-log-check
```

On first run the script creates
`/home/gsg/workspace/project/homelab/deploy/.env` from
`deploy/env.local.example` and exits non-zero. Fill the real target values or set
`HOMELAB_ENV_SOURCE=/path/to/existing/.env` before rerunning. Secrets must stay
on the target host and must not be committed.

Common overrides:

```bash
HOMELAB_GIT_REF=main ./deploy.sh
HOMELAB_GIT_REF=<full-commit-sha> ./deploy.sh
HOMELAB_ENV_SOURCE=/git/vps-config/app/homelab/.env ./deploy.sh
HOMELAB_PROJECT_ROOT=/home/gsg/workspace/project/homelab ./deploy.sh
HOMELAB_DOMAIN=home.gfun.vip ./deploy.sh
HOMELAB_CURL_INSECURE=1 ./deploy.sh
```

## Build and restart flow

The deploy script runs these build commands from the synced source directory:

```bash
CI=true NODE_ENV=development pnpm install --frozen-lockfile
pnpm --filter @homelab/backend build
ADMIN_BACKEND_URL=http://127.0.0.1:3005 \
  NEXT_PUBLIC_ADMIN_API_BASE_URL=/api/backend \
  pnpm --filter @homelab/admin build
NEXT_PUBLIC_SITE_URL=https://home.gfun.vip:8321 \
  pnpm --filter @homelab/portal build
```

The restart step writes fresh systemd user units, then runs:

```bash
systemctl --user daemon-reload
systemctl --user stop homelab-backend homelab-admin homelab-portal
systemctl --user enable homelab-backend homelab-admin homelab-portal
systemctl --user start homelab-backend homelab-admin homelab-portal
```

## Runtime env

Required in `/home/gsg/workspace/project/homelab/deploy/.env`:

- `DATABASE_URL`
- `JWT_SECRET`

Optional:

- `JWT_EXPIRES_IN`
- `INITIAL_ADMIN_USERNAME`
- `INITIAL_ADMIN_PASSWORD`
- `ADMIN_BACKEND_URL`
- `NEXT_PUBLIC_ADMIN_API_BASE_URL`

The deploy script rewrites `ADMIN_BACKEND_URL` to
`http://127.0.0.1:3005` so the admin server-side rewrite targets the local
backend service after deploy.

## Safety gates

- The script exits early when Bash is older than 4. It also checks `git`,
  `node`, `pnpm`, `curl`, `docker`, `systemctl`, and `stat` before build/start.
- Missing env files are bootstrapped from `deploy/env.local.example`, then the
  script exits so an operator can replace placeholders.
- Placeholder `DATABASE_URL` or `JWT_SECRET` values containing `change-me` fail
  the deployment.
- Existing `homelab-backend`, `homelab-admin`, and `homelab-portal` Docker
  containers are stopped and removed before the direct systemd services start.
- nginx registration updates the existing
  `/home/gsg/workspace/app/nginx/config/default.conf` Homelab proxy targets,
  runs `nginx -t`, then reloads or restarts the nginx container.
- Service logs written after the current restart are scanned for fatal/error
  patterns before the final public probes. The restart baseline records each
  log's device/inode identity plus byte size, so replaced/truncated logs are
  scanned from the new file start and historical append logs are not blocking.
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

## Current host assumption

- nginx setup assumes the existing `default.conf` already contains the Homelab
  public listeners and the old Homelab proxy targets. If a fresh host has no
  such nginx config, the certificate/listen contract must be confirmed before
  generating a standalone config safely.
