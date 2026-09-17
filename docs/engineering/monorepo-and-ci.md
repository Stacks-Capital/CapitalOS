# Monorepo and CI

| | |
|---|---|
| Task | I03 Monorepo and CI setup |
| Requirements | OPS-01 |
| Owner / reviewer | IBK / kenzman |
| Date | 2026-09-17 |

Deliverable from the task page: create workspace package boundaries, strict types, lint, tests and build, and secret scanning; a clean checkout builds. Page 01 also assigns the bootstrap scripts and the Compose file to this task.

## Pinned toolchain

| Tool | Version | Where it is pinned |
|---|---|---|
| Node | 24 | `.nvmrc` |
| pnpm | 12.4.1 | `packageManager` in `package.json` |
| TypeScript | 6.0.3 | root `devDependencies` |
| Biome (format and lint) | 2.5.14 | root `devDependencies`, `biome.json` |
| dependency-cruiser (package boundaries) | 18.3.1 | root `devDependencies`, `.dependency-cruiser.cjs` |
| gitleaks (secret scanning) | 8.30.1 | CI downloads the release and verifies its SHA256 |
| `actions/checkout` | v7.0.1 | pinned by commit SHA in `.github/workflows/ci.yml` |
| `actions/setup-node` | v7.0.0 | pinned by commit SHA |
| PostgreSQL | 18.6 (alpine) | `compose.yaml` |
| Redis | 8.10.1 (alpine) | `compose.yaml` |

The workflow file was validated with actionlint 1.7.12, which is not added to the repo.

## Commands

| Command | What it does |
|---|---|
| `pnpm install --frozen-lockfile` | Installs exactly what the lockfile records |
| `pnpm lint` | Biome format check and lint, fails on errors |
| `pnpm lint:fix` / `pnpm format` | Applies Biome fixes / formatting |
| `pnpm boundaries` | Checks package import rules |
| `pnpm typecheck` | Strict typecheck of every package, script folder and the wallet prototype |
| `pnpm test:unit` | Unit tests for packages, the provider probes and the wallet prototype |
| `pnpm test:e2e` | Sandbox round trip fixtures |
| `pnpm test:checks` | Tests that each gate passes good input and fails bad input |
| `pnpm test` | typecheck, unit, e2e and gate tests |
| `pnpm build` | Builds the wallet prototype |
| `pnpm secrets:scan` | gitleaks over the full git history (needs gitleaks installed) |
| `pnpm changeset:status` | Changeset status |
| `pnpm ci` | lint, boundaries, test and build in one go |
| `docker compose up -d --wait postgres redis` | Starts local PostgreSQL and Redis and waits until both are healthy |

## Package boundaries

`pnpm boundaries` fails on any of these:

| Rule | Why |
|---|---|
| `no-circular` | No import cycles |
| `not-to-unresolvable` | Every import must resolve |
| `no-undeclared-dependency` | A package imports only what its `package.json` declares |
| `core-has-no-internal-dependencies` | `core` is the base every package builds on |
| `packages-do-not-import-apps` | Libraries never depend on applications |
| `adapters-do-not-import-ui` | Page 01: an adapter cannot import web UI |
| `web-does-not-import-adapters` | Page 01: the web app calls public SDK methods |
| `no-relative-import-into-another-package` | Other packages are imported by name, so exports stay the only entry point |
| `browser-packages-avoid-node-builtins` | Page 06: `core`, `sdk`, `wallets`, `react` and `ui` stay browser safe (tests excluded) |

The current graph passes: `config`, `wallets` and `adapters` depend on `core`, `adapters` also on `config`, and `fixtures` on all three. `scripts/` is tooling without a `package.json`, so it may import package sources by path.

## Strict types

Every package, both script folders and the wallet prototype extend `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and related flags). `pnpm typecheck` covers all of them.

## Secret scanning

CI scans the whole git history with the gitleaks CLI before installing dependencies. The first scan on 2026-09-17 covered 28 commits and found no leaks.

- The gitleaks GitHub Action was not used: organization repos need a license key, and its v2 release stopped working when GitHub removed Node 20 from runners on 2026-09-16.
- GitHub's own secret scanning for private repositories needs the paid Secret Protection product.
- Locally, scan with `pnpm secrets:scan`, which reads git history. A plain folder scan also reports ignored files such as `.env.local` and build output, which never reach the repo.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, from a clean checkout, with read only repository permissions and without persisting credentials.

| Page 03 PR gate | Step |
|---|---|
| Secret scan | gitleaks over full history |
| Format, lint | `pnpm lint` |
| Typecheck | `pnpm typecheck` |
| Unit | `pnpm test:unit` |
| Affected adapter fixtures | `pnpm test:e2e` (runs all fixtures) |
| Package build | `pnpm build` |
| Schema compatibility | Not yet, see below |

It also runs the package boundary check, the gate tests, changeset status, and starts PostgreSQL and Redis to confirm both become healthy.

## Local services

`compose.yaml` runs PostgreSQL and Redis for local development only. Ports bind to `127.0.0.1`, Redis requires a password (page 03), and the default passwords are local placeholders that can be overridden through `.env.local`. `.env.example` lists the variables.

## Formatting change

This task applied Biome formatting once to the existing code. The changes are whitespace, line breaks, trailing commas, semicolons, one union type leading `|`, one pair of parentheses and quotes on two object keys. No logic changed; typecheck and every test pass before and after.

## Unsupported and deferred

- `test:integration` and `openapi:check` (page 01) are not added yet: there are no integration tests before I04 and no API or OpenAPI document before I05. A placeholder that always passes would count as mocked evidence.
- The page 03 schema compatibility gate waits for API schemas (I05).
- Packages ship TypeScript source (K03 design), so `pnpm build` builds only the wallet prototype.
- Merge, release and production gates from page 03 belong to later tasks.
- Branch protection and required checks cannot be enforced on a private repository under GitHub Free.
- Docker is not installed on the author's machine yet, so the Compose file was validated in CI only.
- Three existing Biome warnings in `packages/adapters/src/sbtc` (unused import and parameters) are left to the package owner.
