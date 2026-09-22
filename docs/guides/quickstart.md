# Quickstart

From a fresh clone to the API, the worker, the Stacks Capital app and the partner example running locally. Every command runs from the repository root.

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node | 24 (pinned in `.nvmrc`) | `node --version` |
| pnpm | 12 (pinned in `package.json`) | `pnpm --version` |
| Docker with Compose | Any recent | `docker compose version` |

```bash
nvm install && nvm use
corepack enable
pnpm install
```

## 2. Configuration

```bash
cp .env.example .env.local
cp apps/web/.env.example apps/web/.env.local
cp apps/embed-example/.env.example apps/embed-example/.env.local
```

Fill in the root `.env.local`: the Postgres and Redis passwords, ports and URLs. If port 5432 is taken by a system Postgres, set `POSTGRES_PORT` to another port and use it in `DATABASE_URL`. `HIRO_API_KEY` is optional and raises provider limits.

Every `.env.local` is git ignored. Keys stay in the root file, which only server processes read. The two app files hold publishable values only, because everything under `VITE_` ships in the browser bundle; the partner example refuses to start if one looks like a key.

## 3. Services and database

```bash
pnpm services:up      # Postgres 18 and Redis 8, waits until healthy
pnpm db:migrate       # applies packages/database/migrations in order
pnpm fixtures:seed    # the registry plus two sandbox apps
```

The seed creates two tenants:

| App | Client id | Allowed origin |
|---|---|---|
| `app_fixture` | `pk_fixture_sandbox` | `http://localhost:5173` (the Stacks Capital app) |
| `app_other` | `pk_other_sandbox` | `http://localhost:5174` (the partner example) |

## 4. Run it

Each in its own terminal:

```bash
pnpm api:dev          # API on http://127.0.0.1:3000, needs REDIS_URL
pnpm worker:tick      # one ingestion tick against mainnet; worker:run keeps going
pnpm web:dev          # Stacks Capital app on http://localhost:5173
pnpm embed:dev        # partner example on http://localhost:5174
```

Check the API answers:

```bash
curl -s -H 'x-capital-client-id: pk_fixture_sandbox' -H 'origin: http://localhost:5173' \
  'http://127.0.0.1:3000/v1/markets?network=mainnet' | head -c 300
```

## 5. A server key

Server side callers (quotes, plans, the partner program) use an API key. The token is printed once and only its hash is stored.

```bash
pnpm keys:create app_fixture markets:read quotes:write
pnpm keys:revoke key_<16 hex characters>
```

Keep the token in a server secret store. Never put it in a `VITE_` value or send it from a browser: the API refuses a key that comes with an `Origin` header.

## 6. Verify the setup

```bash
pnpm run ci              # lint, boundaries, types, unit tests, build, generated docs
pnpm test:integration    # against the local Postgres
pnpm test:browser        # Playwright, starts its own API on 3100 and the app
pnpm db:restore-drill    # backup and restore proof, see docs/runbooks/backup-restore.md
```

A setup is reproduced when all four pass. Record the result in the reproduction record at the end of [the incident runbook](../runbooks/incidents.md#reproduction-record).

## Common problems

| Symptom | Cause | Fix |
|---|---|---|
| `REDIS_URL is not set` from the API | Root `.env.local` missing or incomplete | Step 2 |
| `password authentication failed` | The volume was created with an older password | `pnpm services:down`, remove the volume, `pnpm services:up` |
| `VITE_CLIENT_ID is not set` | App `.env.local` missing | Step 2 |
| `FORBIDDEN` from the browser | Origin does not match the client id | Use port 5173 with `pk_fixture_sandbox`, 5174 with `pk_other_sandbox` |
| `permission denied` on the Docker socket | Your user is not in the `docker` group | `sudo usermod -aG docker $USER`, then log in again |

## Next

- [API errors](../reference/api-errors.md) for every error code and what to do.
- [Embedding](../engineering/embedding.md) for the browser packages and widgets.
- [Adapter guide](adapter-guide.md) for adding a protocol.
