# Homelab

TypeScript monorepo baseline for the Homelab product.

## Stack

- Monorepo: pnpm workspace + Turborepo
- Backend: Node.js + NestJS
- Admin: Next.js
- Database: PostgreSQL + Prisma
- Auth: JWT
- AppKey: `X-App-Key` request header, shared identity mechanism for App Agent access

## Local Setup

```bash
pnpm install
cp .env.example apps/backend/.env
pnpm --filter @homelab/backend prisma:generate
pnpm --filter @homelab/backend prisma:migrate
pnpm --filter @homelab/backend dev
```

Health check:

```bash
curl http://localhost:3000/health
```

Admin console:

```bash
pnpm --filter @homelab/admin dev
```

The admin app runs on `http://localhost:3002` and proxies `/api/backend/*` to the backend. Set `ADMIN_BACKEND_URL` when the backend is not on `http://localhost:3000`, or set `NEXT_PUBLIC_ADMIN_API_BASE_URL` to call another API base directly from the browser.

## Environment Variables

| Name                             | Required | Description                                                                        |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | yes      | PostgreSQL connection string used by Prisma.                                       |
| `PORT`                           | no       | Backend port, defaults to `3000`.                                                  |
| `JWT_SECRET`                     | yes      | Secret used to sign JWT access tokens.                                             |
| `JWT_EXPIRES_IN`                 | no       | JWT lifetime, defaults to `1h`.                                                    |
| `INITIAL_ADMIN_USERNAME`         | no       | Admin username to seed at startup when paired with password.                       |
| `INITIAL_ADMIN_PASSWORD`         | no       | Admin password to seed/update at startup when paired with username.                |
| `ADMIN_BACKEND_URL`              | no       | Admin Next.js rewrite target for backend API, defaults to `http://localhost:3000`. |
| `NEXT_PUBLIC_ADMIN_API_BASE_URL` | no       | Browser-visible admin API base, defaults to `/api/backend`.                        |

## Backend API

- `GET /health`
- `POST /auth/login`
- `GET /auth/me`
- `GET /users`
- `POST /users`
- `PATCH /users/:id`
- `DELETE /users/:id`
- `POST /users/:id/reset-password`
- `POST /app-keys`
- `GET /app-keys`
- `DELETE /app-keys/:id`
- `GET /app-identity/me` with `X-App-Key`

Admin-only endpoints require `Authorization: Bearer <jwt>`.

## Test and Build

```bash
pnpm test
pnpm build
```

`pnpm test` and `pnpm build` run backend lifecycle hooks that generate Prisma Client before compiling or testing. Fresh checkouts do not require a separate manual `prisma generate` step for those commands.

## Docker

The repository builds one unified backend runtime image from `deploy/Dockerfile`.
Runtime configuration is injected with environment variables; do not bake secrets
or production credentials into the image.

```bash
make image-build
make image-run
curl http://localhost:3000/health
```

The Make targets accept overrides when needed:

```bash
make image-build IMAGE_NAME=homelab:test
make image-run IMAGE_NAME=homelab:test ENV_FILE=apps/backend/.env PORT=3000
```

The image exposes port `3000` by default and includes a Docker health check for
`GET /health`. Override `PORT` through the container environment if a different
port is needed.

## GHCR Tag Publishing

GitHub Actions publishes the unified image when a tag matching `v*.*.*` is
pushed. Use the Make target from a clean working tree:

```bash
make deploy-image VERSION=v1.0.0
```

Workflow: `.github/workflows/tag-image.yml`

Published image names:

- `ghcr.io/<owner>/<repo>:<tag>`, for example `ghcr.io/gsgsdtc/homelab:v1.0.0`
- `ghcr.io/<owner>/<repo>:latest`

Required repository settings:

- Actions must be enabled.
- The workflow uses the built-in `GITHUB_TOKEN`.
- Job permissions must include `contents: read` and `packages: write`.

No extra registry secret is required for GHCR in this repository. If package
publishing permissions are missing, the workflow fails during login or push and
the failing step identifies the GHCR authentication or authorization problem
without printing token values.

## Local Host Deployment

`ops-deploy.sh` is the target-host deployment entry for
`/home/gsg/workspace/project/homelab`. It syncs the configured Git ref, validates
host dependencies and runtime env, builds backend/admin/portal Docker services,
starts or restarts them, validates nginx, checks recent logs, probes public
health URLs, and prints QA-accessible URLs.

```bash
make ops-deploy-check
make ops-deploy
```

The Stage 1 public URL contract is:

- Portal: `https://home.gfun.vip:8321/`
- Admin: `https://home.gfun.vip:8322/login`
- Backend: `https://home.gfun.vip:8323/health`
- Admin rewrite: `https://home.gfun.vip:8322/api/backend/health`

See `deploy/local-deploy.md` for target paths, env handling, nginx registration,
Prisma baseline safety, and override variables. This local deployment path does
not change the existing GHCR tag publishing workflow.
