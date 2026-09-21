# SDK release candidate and compatibility (K39)

| | |
|---|---|
| Tasks | K39 Publish and compatibility-test SDK releases |
| Owner / reviewer | Kenzman / IBK |
| Depends on | K22, K38, I29 |

Versions the partner packages to **0.1.0**, packs them as release-candidate tarballs, proves a clean install can import them, and runs the partner example. **Does not publish to a registry** (packages remain `private`).

## Packages

| Package | Role |
|---|---|
| `@stacks-capital/sdk` | Validate unsigned plans; never broadcasts |
| `@stacks-capital/client` | HTTP to Capital API |
| `@stacks-capital/react` | Hooks |
| `@stacks-capital/ui` | Widgets + wallet request helpers |
| `@stacks-capital/core` | Types and shared finance helpers |
| `@stacks-capital/wallets` | Leather / Xverse guards |
| `@stacks-capital/config` | Transitive (registry / capabilities) for the SDK |

## Commands

```sh
pnpm gate:k39
pnpm sdk:compat
pnpm partner:example
```

Evidence: `docs/release/evidence/k39-latest.json` and `k39-latest.md`.

Migration notes for partners: [`docs/guides/sdk-migration-0.1.md`](../guides/sdk-migration-0.1.md).

## Compatibility matrix

| Dimension | Supported |
|---|---|
| Node | 22, 24 |
| React | ^19 |
| Wallets | leather, xverse |
| schemaVersion | 1.0 |

## Acceptance mapping

| Evidence | How |
|---|---|
| Clean installs from published artifacts | `pnpm pack` all release packages → extract into a disposable workspace → `pnpm install` → import smoke |
| Breaking changes have migration notes | `docs/guides/sdk-migration-0.1.md` |
| Partner example against RC | `pnpm partner:example` on the same 0.1.0 versions |
