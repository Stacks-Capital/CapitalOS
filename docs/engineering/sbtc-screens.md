# Bitcoin Bridge and Withdrawal Screens (I33)

This document describes the design, state machines, accounting rules, failure recovery, and browser persistence for the Bitcoin to sBTC deposit and sBTC to Bitcoin withdrawal journeys in `apps/web`.

## 1. Overview and UX Surface

The Bitcoin bridge interface lives under the **Deposit BTC** tab in the shell navigation (`apps/web/src/depositBtcScreen.tsx`), replacing the former unbuilt placeholder. It provides a toggle between two directions:
1. **Deposit (BTC → sBTC)**: Moving native Bitcoin to sBTC on Stacks via Emily signers and canonical mints.
2. **Withdraw (sBTC → BTC)**: Initiating a withdrawal request on Stacks and receiving native Bitcoin via signer fulfillment.

### Separation of Balances Invariant

Pending BTC (Bitcoin in transit or waiting for signer mint) and spendable sBTC (confirmed, spendable balance on Stacks) are **strictly distinct**. They are never added, merged, or displayed as one combined figure anywhere on the screen or in portfolio views (`assertDistinctBalances`).

---

## 2. Certified Lifecycle State Machines

### 2.1 Deposit Lifecycle (K25)

CapitalOS treats a Bitcoin transaction, Emily signer status, and a canonical Stacks mint as three distinct facts:
- **`submitted`**: Bitcoin deposit transaction broadcast to the network.
- **`confirming`**: Bitcoin observer tracks block height and confirmations against the required threshold.
- **`signer_processing`**: Public Emily reports status (`pending`, `accepted`, `confirmed`).
- **`mint_pending`**: Signers accepted; awaiting canonical `completed-deposit` event in Stacks block.
- **`reclaimable`**: Appears **only** when the observed Bitcoin tip reaches Emily's lock height without a canonical mint. If current tip < lock height, recovery is displayed as locked with remaining blocks.
- **`reconciled`**: Exact matching evidence observed (txid, output index, recipient, and minted amount within the signed maximum-fee bound).
- **`reconciliation_failed`**: Any identity or amount mismatch fails closed for investigation.

> **Rule**: Incomplete deposit states (`submitted`, `confirming`, `signer_processing`, `mint_pending`) are **never badged as complete**.

### 2.2 Withdrawal Lifecycle (K26)

CapitalOS separates the Stacks request, signer status, canonical accounting, and Bitcoin payout:
- **`request_confirming`**: Stacks transaction initiated via `sbtc-withdrawal` contract call.
- **`signer_processing`**: Emily reports status for the request ID. Expected fulfillment txids and heights from Emily are labeled as estimates.
- **`signer_rejection_pending`**: If signers reject the request (`status: "failed"` in Emily), funds remain locked in the contract until the canonical registry records the rejection status. It is **never** presented as recovered funds until that on-chain transaction unlocks the funds atomically.
- **`payout_confirming`**: Signer Bitcoin fulfillment broadcast; awaiting Bitcoin confirmations.
- **`reconciled`**: Independent observation of the exact Bitcoin output agreeing on transaction, output, block, and fee with canonical completion evidence.

> **Rule**: The Stacks transaction (`stx_callContract`) is only a wallet response, **never proof of an accepted withdrawal or Bitcoin payout**.

---

## 3. Exact Accounting Shown to the User

All quantities are handled as base-10 strings and BigInt representations (satoshis / sBTC base units with 8 decimal places):

### Deposit Accounting
- `deposit amount`: Bitcoin input requested in satoshis.
- `maximum signer fee`: fee ceiling selected before deposit.
- `minimum expected mint`: `deposit amount - maximum signer fee`.
- `actual signer fee`: calculable as `deposit sats - minted sats` upon canonical mint.

### Withdrawal Accounting
- `withdrawal amount`: exact BTC output requested at the destination Bitcoin address.
- `maximum signer fee`: fee ceiling selected before signing.
- `initially locked sBTC`: `withdrawal amount + maximum signer fee`.
- `actual signer fee`: fee in the canonical acceptance event.
- `final sBTC debit`: `withdrawal amount + actual signer fee`.
- `refunded sBTC`: unused maximum fee returned atomically by the contract.
- `Bitcoin received`: independently observed output amount, shown only after exact reconciliation.

---

## 4. Failure Modes and Recovery

1. **Broadcast Unknown (`BROADCAST_UNKNOWN` / Missing txid)**:
   If the wallet returns no transaction id, or the broadcast state cannot be confirmed, the workflow transitions to `FailedDelayedStateView` for investigation. An automatic second broadcast is **strictly forbidden** to prevent moving funds twice. The user is provided a support copy action for the workflow ID.
2. **Reclaim Maturity**:
   In deposit flow, when Emily lock height is reached without a canonical mint, the screen displays a `Reclaim Bitcoin deposit` recovery button.
3. **Signer Rejection**:
   In withdrawal flow, signer rejection is labeled `signer_rejection_pending` with an explanation that funds remain locked until the registry confirms rejection.
4. **Reload Persistence**:
   Closing or refreshing the browser does not lose state. On mount, `DepositBtcScreen` queries `useWorkflows` for `action === "withdraw_sbtc"` or `action === "deposit_sbtc"` to restore the ongoing journey directly from the API.

---

## 5. Testnet Availability Guard

Emily beta does not track public Stacks testnet, and Leather has no Bitcoin regtest. On testnet (`wallet.network === "testnet"`), the screen renders a truthful `UnsupportedStateView` stating that testnet bridge execution is disabled.

---

## 6. Verification and Certification

- Pure UI domain logic: `packages/ui/src/sbtc.test.ts`
- Web app screens: `apps/web/src/depositBtcScreen.tsx` wired in `apps/web/src/app.tsx`
- Monorepo boundary compliance: `scripts/checks/architecture.ts` and `scripts/checks/run-dependency-cruiser.ts`
- Adapter certification: `pnpm adapters:certify`
- Browser e2e journeys: `apps/e2e/tests/journeys.spec.ts` and `apps/e2e/tests/access.spec.ts`
