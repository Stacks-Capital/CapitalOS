# Plan hardening (K34)

| | |
|---|---|
| Tasks | K34 Harden quotes, plans, exact arithmetic and post-conditions |
| Owner / reviewer | Kenzman / IBK |
| Depends on | K25–K33 |

Plans are signed only after local validation binds them to the quote, registry, deployment allowlist, adapter version, network and shared expiry. The wallet request path refuses to open unless that validation succeeded.

## Binding checks

`validatePlan` / `assertReadyToSign` reject when any of the following fail:

- Quote id, network, registry version and adapter version disagree between plan, quote and signing context
- Plan `expiresAt` differs from the quote, or either is already stale
- A Stacks call targets a contract outside the signed deployment allowlist, uses allow-mode post conditions, or carries a different `network` than the plan
- Bitcoin deposit `bitcoinNetwork` is not the Bitcoin network paired to the Stacks network
- Send post-condition principals do not match the sender, or amounts are missing from quote input
- Receive post-condition amounts are missing from quote expected/minimum output
- Expected asset effects do not cover quote expected output, or invent amounts absent from the quote
- Step `dependsOn` references are unknown or self-referential
- Any token quantity is a JavaScript number (wire parse and payload checks both refuse numbers)

## Wallet gate

- `@stacks-capital/sdk` `recordPlan(workflow, plan, quote, signing?)` calls `assertReadyToSign` before moving to `AWAITING_SIGNATURE`
- `@stacks-capital/ui` `toWalletRequest` / `askWallet` require a successful `PlanValidation`; a failed validation never builds or sends a wallet request

```ts
const validation = os.validate(plan, quote, { sender });
os.assertReadyToSign(plan, quote, { sender });
const request = toWalletRequest(step, validation);
await askWallet(provider, "leather", request, validation);
```

## Tests

```sh
pnpm --filter @stacks-capital/core test
pnpm --filter @stacks-capital/sdk test
pnpm --filter @stacks-capital/ui test
pnpm --filter @stacks-capital/adapters test
pnpm adapters:certify
```
