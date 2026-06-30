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

| Name | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string used by Prisma. |
| `PORT` | no | Backend port, defaults to `3000`. |
| `JWT_SECRET` | yes | Secret used to sign JWT access tokens. |
| `JWT_EXPIRES_IN` | no | JWT lifetime, defaults to `1h`. |
| `INITIAL_ADMIN_USERNAME` | no | Admin username to seed at startup when paired with password. |
| `INITIAL_ADMIN_PASSWORD` | no | Admin password to seed/update at startup when paired with username. |
| `ADMIN_BACKEND_URL` | no | Admin Next.js rewrite target for backend API, defaults to `http://localhost:3000`. |
| `NEXT_PUBLIC_ADMIN_API_BASE_URL` | no | Browser-visible admin API base, defaults to `/api/backend`. |

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

```bash
docker build -f deploy/Dockerfile -t homelab:local .
docker run --env-file apps/backend/.env -p 3000:3000 homelab:local
```
