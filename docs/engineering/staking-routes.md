# Certified stacking and staking routes (K33)

Stacks Capital distinguishes three things that products often conflate:

1. **Native Bitcoin / PoX staking** (`pox-5` stake / unstake) — locks L1 Bitcoin.
2. **sBTC DeFi** — deposit, withdraw, Zest supply, Granite credit, Bitflow swap.
3. **Protocol receipt staking** (Hermetica and similar) — separate earn products (K31).

Native staking stays **capability-disabled** until Bitcoin L1 lockup signing is verified (K16). `evaluateStaking` always returns `unavailable` with `broadcastAllowed: false` and documents that zsBTC is not a staking position.

```sh
pnpm --filter @stacks-capital/adapters test
```
