# Contract and market feasibility matrix

| | |
|---|---|
| Task | K01 Contract and market feasibility matrix |
| Requirements | CAP-01, EARN-01, SBTC-01 |
| Owner / reviewer | kenzman / IBK |
| Observed | 2026-09-15, Stacks testnet and mainnet |
| Decision it informs | First lending adapter (K09), sBTC adapters (K07/K08), staking gate (K16) |

This records verified contract principals, revisions, methods and whether the action is executable. Provider endpoints, quotas and Emily limits stay in `docs/discovery/provider-inventory.md` (I01). Wallet signing behavior stays in `docs/discovery/wallet-feasibility.md` (I02). Contract IDs that I01 already measured are reused, not replaced.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node --experimental-strip-types scripts/contracts/probe.ts
```

## Canonical deployments

| Protocol | Label | Network | Contract | Revision (deploy height) | User-executable methods | Status |
|---|---|---|---|---|---|---|
| sBTC | sbtc-token | mainnet | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` | 328228 | `transfer`, SIP-010 reads | Usable. Same principal as I01. |
| sBTC | sbtc-deposit | mainnet | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-deposit` | 328228 | none for users | Signer-only `complete-deposit-wrapper`. User path is Bitcoin + Emily. |
| sBTC | sbtc-withdrawal | mainnet | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-withdrawal` | 328228 | `initiate-withdrawal-request` | Usable. Locks `amount + max-fee`. Dust 546. Recipient is `{version, hashbytes}`. |
| sBTC | sbtc-registry | mainnet | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry` | 328228 | reads | Status and request lookup. |
| sBTC | sbtc-token | testnet | `SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token` | 1162 | SIP-010 | Canonical testnet token from docs.stacks.co. I01 npm principal `SNGWPN3XDAQE673MXYXF81016M50NHF5X5PWWM70` stays excluded. |
| sBTC | sbtc-deposit / withdrawal / registry | testnet | same deployer as token | 1162–1163 | same ABI as mainnet | Contracts exist on Hiro testnet. Emily beta does not track this chain (I01 F2), so deposit/withdraw stay **disabled**. |
| USDCx | usdcx | mainnet | `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx` | 5199972 | `transfer`, balance reads | Borrow asset for Granite (K12). 6 decimals. |
| USDCx | usdcx | testnet | `ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx` | 17815 | same | Matches I01. |
| Zest v2 | v0-vault-sbtc | mainnet | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc` | 6162063 | `deposit`, `redeem` | **First lending / earn market.** Underlying is sbtc-token. Symbol `zsBTC`, 8 decimals. Live pause flags all false. Supply cap 5000 BTC, debt cap 100 BTC, total assets 660.22279734 sBTC at observation. |
| Zest v2 | v0-vault-usdc | mainnet | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdc` | 6162068 | `deposit`, `redeem`, `system-borrow` | USDCx liquidity vault used by Granite borrow. Underlying USDCx, zUSDC 6 decimals. Not an earn adapter. |
| Granite | v0-8-market | mainnet | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market` | 8883545 | `collateral-add`, `borrow`, `repay`, `collateral-remove` | Isolated sBTC collateral + USDCx debt. Same deployer family as Zest vaults. Not comparable to zsBTC earn. `v0-4-market` is superseded. price-feeds omitted only when the oracle is already fresh (I01 Pyth key still blocked). |
| Zest v2 | v0-4-market | mainnet | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market` | 6819891 | superseded | Recorded so Granite/v0-4 labels are not treated as the live market. |
| Bitflow | dlmm-swap-router-v-1-2 | mainnet | `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2` | 6979616 | `swap-x-for-y-simple-range-multi`, `swap-y-for-x-simple-range-multi` | Executable swap router. Extra `deadline-time` vs v-1-1. Allowlisted sBTC↔USDCx only. Live pool principal is **not pinned**. |
| Bitflow | dlmm-swap-router-v-1-1 | mainnet | `SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1` | 6909217 | superseded | Same swap family without deadline. Not the adapter target. |
| PoX | pox-5 | mainnet | `SP000000000000000000002Q6VF78.pox-5` | 8665568 | `stake`, `unstake`, `unstake-sbtc` | Exists. Staking capability stays **disabled** (K02). |
| PoX | pox-5 | testnet | `ST000000000000000000002AMW42H.pox-5` | 2822 | same family | Exists. Disabled. |

Zest has no public testnet deployment of these principals (404 on `api.testnet.hiro.so`). Bitflow remains mainnet-only (I01).

## First earn market selection

K09 uses **Zest `v0-vault-sbtc` deposit/redeem**, not `zvstBTC` (pooled strategy vault, MVP exclusion) and not `v0-8-market` borrow.

| Need | Method | Rounding | Post-condition |
|---|---|---|---|
| Supply sBTC | `deposit(amount, min-out, recipient)` | shares round down (`mul-div-down`) | deny-mode send of sBTC |
| Withdraw supply | `redeem(amount, min-out, recipient)` | assets round down | deny-mode send of zsBTC |

Portfolio must count zsBTC as the supplied claim, not as a second asset on top of sBTC.

## Unsupported cases

- sBTC deposit/withdraw on public Stacks testnet through Emily beta.
- Zest on testnet.
- `v0-4-market` as a live adapter target.
- Strategy vault `zvstBTC`.
- Bitcoin Staking as an executable action.
- Arbitrary permissionless routing. Bitflow is sBTC↔USDCx on router v-1-2 only; live pool is unpinned.

## Recommendation

| Action | Mainnet | Testnet |
|---|---|---|
| BTC → sBTC | Enabled, Bitcoin payload + Emily | Disabled |
| sBTC → BTC | Enabled, `initiate-withdrawal-request` | Disabled |
| Earn supply/withdraw | Zest `v0-vault-sbtc` | Disabled |
| Isolated collateral | Granite `v0-8-market` `collateral-add` / `collateral-remove` | Disabled |
| Borrow/repay USDCx | Granite `v0-8-market` | Disabled |
| Swap sBTC↔USDCx | Bitflow `dlmm-swap-router-v-1-2`, fixture route until a pool is pinned | Disabled |
| Stake | Disabled | Disabled |
