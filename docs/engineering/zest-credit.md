# Certified Zest credit availability (K28)

Zest Protocol's reviewed Stacks deployments do **not** expose a user-executable collateral, borrow, or repay surface.

| Contract | Role | User methods |
|---|---|---|
| `v0-vault-sbtc` | Earn vault (K27) | `deposit`, `redeem` |
| `v0-vault-usdc` | USDCx liquidity / debt vault | `deposit`, `redeem`, `system-borrow` (not a user borrow path) |
| `v0-4-market` | Superseded | Not an adapter target |

Isolated sBTC collateral and USDCx borrow/repay live on **Granite `v0-8-market`** (K32). That market shares a deployer family with Zest vaults but is a different protocol and market id (`granite.sbtc.isolated`). zsBTC must never be treated as Granite collateral.

## Certification

`evaluateZestCredit` always returns `unavailable` with `broadcastAllowed: false`. It names the reviewed contracts and redirects partners to the Granite market. This is intentional fail-closed behaviour, not a stub.

```sh
pnpm --filter @stacks-capital/adapters test
```

Live provider responses are not relabeled as Zest borrow evidence.
