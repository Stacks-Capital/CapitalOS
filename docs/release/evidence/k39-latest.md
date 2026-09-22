# K39 gate evidence

| | |
|---|---|
| Generated | 2026-09-22T10:53:58.732Z |
| Release candidate | 0.1.0 |
| Node | v24.21.0 |
| Result | **PASS** |

## Checks

| Category | ID | Result | Detail |
|---|---|---|---|
| version | version:@stacks-capital/core | pass | 0.1.0; private; engines.node=>=22 |
| version | version:@stacks-capital/config | pass | 0.1.0; private; engines.node=>=22 |
| version | version:@stacks-capital/wallets | pass | 0.1.0; private; engines.node=>=22 |
| version | version:@stacks-capital/sdk | pass | 0.1.0; private; engines.node=>=22 |
| version | version:@stacks-capital/client | pass | 0.1.0; private; engines.node=>=22 |
| version | version:@stacks-capital/react | pass | 0.1.0; private; engines.node=>=22 |
| version | version:@stacks-capital/ui | pass | 0.1.0; private; engines.node=>=22 |
| matrix | react-peer | pass | ^19.0.0 |
| matrix | node-major | pass | running v24.21.0; supported 22,24 |
| matrix | wallet:leather | pass | reject=USER_REJECTED; unsupported=UNSUPPORTED_WALLET |
| matrix | wallet:xverse | pass | reject=USER_REJECTED; unsupported=UNSUPPORTED_WALLET |
| pack | pack:@stacks-capital/core | pass | /tmp/capitalos-k39-pack-XNf4rH/stacks-capital-core-0.1.0.tgz |
| pack | pack:@stacks-capital/config | pass | /tmp/capitalos-k39-pack-XNf4rH/stacks-capital-config-0.1.0.tgz |
| pack | pack:@stacks-capital/wallets | pass | /tmp/capitalos-k39-pack-XNf4rH/stacks-capital-wallets-0.1.0.tgz |
| pack | pack:@stacks-capital/sdk | pass | /tmp/capitalos-k39-pack-XNf4rH/stacks-capital-sdk-0.1.0.tgz |
| pack | pack:@stacks-capital/client | pass | /tmp/capitalos-k39-pack-XNf4rH/stacks-capital-client-0.1.0.tgz |
| pack | pack:@stacks-capital/react | pass | /tmp/capitalos-k39-pack-XNf4rH/stacks-capital-react-0.1.0.tgz |
| pack | pack:@stacks-capital/ui | pass | /tmp/capitalos-k39-pack-XNf4rH/stacks-capital-ui-0.1.0.tgz |
| install | clean-install | pass | pnpm install from packed tarballs (extracted workspace) |
| install | clean-import-smoke | pass | k39-consumer-ok 0.1.0 1.0 |
| partner | partner:example | pass | pass |
| partner | sdk:compat | pass | pass |
| migration | migration-notes | pass | /home/modev/Stacks Ecosystem/CapitalOS/docs/guides/sdk-migration-0.1.md |

## Compatibility matrix

| Dimension | Supported |
|---|---|
| Node major | 22, 24 |
| React | ^19.0.0 |
| Wallets | leather, xverse |
| schemaVersion | 1.0 |

## Limitations

- Clean install extracts packed tarballs into a disposable workspace (packages stay private / unpublished).
- Source packs ship TypeScript; consumers need Node >=22 with --experimental-strip-types or a bundler.
- Partner example still uses workspace fixtures/engine for the demo API host; partner-facing imports stay on the public SDK surface.
- Browser wallet UX is covered by unit classifyWalletError + embed/UI tests, not a live Leather/Xverse session in this gate.

## Commands

```sh
pnpm gate:k39
pnpm partner:example
pnpm sdk:compat
```
