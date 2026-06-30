# Homelab

TypeScript monorepo baseline for the Homelab product.

## Stack

- Monorepo: pnpm workspace + Turborepo
- Backend: Node.js + NestJS
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

## Environment Variables

| Name | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string used by Prisma. |
| `PORT` | no | Backend port, defaults to `3000`. |
| `JWT_SECRET` | yes | Secret used to sign JWT access tokens. |
| `JWT_EXPIRES_IN` | no | JWT lifetime, defaults to `1h`. |
| `INITIAL_ADMIN_USERNAME` | no | Admin username to seed at startup when paired with password. |
| `INITIAL_ADMIN_PASSWORD` | no | Admin password to seed/update at startup when paired with username. |

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

## Docker

```bash
docker build -f deploy/Dockerfile -t homelab:local .
docker run --env-file apps/backend/.env -p 3000:3000 homelab:local
```
