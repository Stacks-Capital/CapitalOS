# Capital OS Partner Integration Guide

A complete, end-to-end guide for external partners integrating with Capital OS using public packages (`@stacks-capital/sdk`, `@stacks-capital/client`, `@stacks-capital/react`, `@stacks-capital/ui`).

---

## 1. Overview & Architecture

Capital OS operates under a **hybrid execution architecture**:
1. **Server API (`apps/api`)**: Mints versioned, deterministic quotes and execution plans, evaluates risk and oracle quorums, tracks durable workflows, and delivers authenticated webhooks.
2. **Client SDK (`@stacks-capital/sdk`)**: Runs in the partner application (Node.js or browser). Validates unsigned plans against the active on-chain contract registry, evaluates wallet safety guards, and tracks workflow state up to signature readiness.
3. **Host Wallet / Broadcast**: The partner or user wallet (e.g. Leather, Xverse) inspects post-conditions, signs transactions, and broadcasts directly to the Stacks or Bitcoin network. **The SDK never holds private keys and never broadcasts writes.**

```
+-----------------------------------------------------------------------------------+
|                               Partner Application                                 |
|                                                                                   |
|  1. Request Quote & Plan         3. Validate Plan           4. Sign & Broadcast   |
|     (POST /v1/quotes)             (SDK `os.validate`)          (Leather / Xverse) |
+--------------+---------------------------+--------------------------+-------------+
               |                           ^                          |
               | HTTP                      | Unsigned Plan            | Direct RPC
               v                           |                          v
+--------------+-------------+             |              +-----------+-------------+
|      Capital OS API        |-------------+              | Stacks / Bitcoin Network|
|  - Engine & Adapters       |                            |                         |
|  - Oracle Quorum Validator |                            |  5. On-chain Events     |
|  - Webhook Dispatcher      |                            +-----------+-------------+
+--------------+-------------+                                        |
               |                                                      |
               | 6. Signed Webhook (HMAC-SHA256)                      |
               v                                                      | Ingestion /
+--------------+-------------+                                        | Observer
|  Partner Webhook Endpoint  | <--------------------------------------+
+----------------------------+
```

---

## 2. Installation & Compatibility

Install the public packages in your project:

```bash
# Core SDK & API Client
pnpm add @stacks-capital/sdk @stacks-capital/client

# Optional React hooks & UI components
pnpm add @stacks-capital/react @stacks-capital/ui
```

### Compatibility Matrix

| Dimension | Supported Version | Notes |
|---|---|---|
| **Node.js** | `>=22` (tested on Node 22 & 24) | Required for ES modules and modern crypto APIs |
| **React** | `^19.0.0` | Peer dependency for `@stacks-capital/react` and `@stacks-capital/ui` |
| **Wallets** | Leather, Xverse | Browser extensions supported via standard SIP-010 / Stacks connect |
| **Envelope Schema** | `1.0` | Strict envelope versioning; requests/responses must match `schemaVersion: "1.0"` |
| **Networks** | `mainnet`, `testnet` | Explicit network specification is mandatory |

> [!IMPORTANT]
> **Zero Internal Imports**: Partner applications must consume only `@stacks-capital/sdk`, `@stacks-capital/client`, `@stacks-capital/react`, and `@stacks-capital/ui` (and types re-exported from `@stacks-capital/core` / `@stacks-capital/wallets`). Do **not** import from `@stacks-capital/engine`, `@stacks-capital/adapters`, or `@stacks-capital/fixtures`.

---

## 3. Authentication & Tenant Scoping

Capital OS uses scoped credentials to authenticate API calls:

### Server-to-Server Authentication
For backend microservices minting quotes or managing webhooks, include an API bearer token:
```http
Authorization: Bearer key_<id>.<secret>
```

### Browser / Client-Side Authentication
For browser frontends reading public markets or submitting quotes via user session, include the publishable client ID header:
```http
x-capital-client-id: pk_<tenant_client_id>
```

### Tenant Scopes

| Scope | Allowed Operations |
|---|---|
| `markets:read` | Inspect capabilities, active markets, prices, oracle evidence, and risk disclosures |
| `positions:read` | Read portfolio valuations, collateral/debt accounting, and address balances |
| `quotes:write` | Request new quotes and execution plans (`/v1/quotes`, `/v1/plans`) |
| `workflows:write` | Create and advance durable workflows (`/v1/workflows`) |
| `webhooks:manage` | Register, rotate, and manage webhook subscription endpoints |

If an endpoint is called with insufficient scopes or an invalid token, the API responds with typed RFC 7807 problem details:

```json
{
  "schemaVersion": "1.0",
  "requestId": "req_0192837482",
  "error": {
    "code": "FORBIDDEN",
    "message": "API key is missing the webhooks:manage scope",
    "action": "Use a caller with the right scope. Never send an API key from a browser."
  }
}
```

---

## 4. Wallet Integration

The `@stacks-capital/sdk` provides network guards and wallet error classifiers to normalize errors across different wallet vendors (Leather, Xverse).

```typescript
import { classifyWalletError, networkGuard } from "@stacks-capital/sdk";

// 1. Guard against wrong-network addresses before calling the API
const networkError = networkGuard({ stx: userStxAddress }, "mainnet");
if (networkError) {
  throw new Error(`Invalid address for mainnet: ${networkError}`);
}

// 2. Classify wallet responses
try {
  const result = await hostWallet.signTransaction(txRequest);
} catch (error) {
  const category = classifyWalletError("leather", error);
  if (category === "USER_REJECTED") {
    console.log("User canceled signature in wallet extension.");
  } else if (category === "UNSUPPORTED_WALLET") {
    console.error("Wallet extension does not support this method.");
  } else {
    console.error("Wallet failure:", error);
  }
}
```

---

## 5. Quoting & Planning Lifecycle

Capital OS enforces deterministic two-step transactions:
1. **Quote**: Represents financial terms (amounts, minimum outputs, fees, oracle snapshots, expiry).
2. **Plan**: Represents the exact execution steps (contract calls, post-conditions, recipient, function args).

### 5.1 Sandbox Entry: Supplying sBTC to Zest Earn Vault

Entry flows deposit assets into protocols (e.g. sBTC into Zest v0-vault) and receive claim tokens (zsBTC):

```typescript
import {
  createCapitalOS,
  parsePlan,
  parseQuote,
  requireNetwork,
} from "@stacks-capital/sdk";

export async function supplyZest(apiBase: string, ownerAddress: string) {
  requireNetwork("mainnet");
  const os = createCapitalOS({ network: "mainnet" });

  // 1. Mint quote and plan from Capital API
  const response = await fetch(`${apiBase}/v1/quotes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      network: "mainnet",
      owner: ownerAddress,
      action: "supply",
      marketId: "zest.sbtc.vault",
      amount: "100000000", // 1.0 sBTC in base units (8 decimals)
    }),
  });
  const { data } = await response.json();
  const { quote, plan } = data;

  // 2. Validate plan locally against active contract registry
  const validation = os.validate(parsePlan(plan), parseQuote(quote), { sender: ownerAddress });
  if (!validation.ok) {
    throw new Error(`Plan validation failed: ${validation.reasons.join("; ")}`);
  }

  // 3. Initialize durable workflow
  let flow = os.startWorkflow({ id: "entry-flow-1", idempotencyKey: "supply-sbtc-001" });
  flow = os.recordQuote(flow, parseQuote(quote));
  flow = os.recordPlan(flow, parsePlan(plan), parseQuote(quote), { sender: ownerAddress });

  // 4. Assert ready to sign (workflow state is AWAITING_SIGNATURE)
  os.assertReadyToSign(parsePlan(plan), parseQuote(quote), { sender: ownerAddress });

  return { quote, plan, workflow: flow };
}
```

### 5.2 Sandbox Exit: Redeeming zsBTC from Zest Earn Vault

Exit flows redeem claim tokens back into underlying assets (e.g. zsBTC back to sBTC):

```typescript
export async function withdrawZest(apiBase: string, ownerAddress: string) {
  requireNetwork("mainnet");
  const os = createCapitalOS({ network: "mainnet" });

  // 1. Request redemption quote and plan
  const response = await fetch(`${apiBase}/v1/quotes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      network: "mainnet",
      owner: ownerAddress,
      action: "withdraw_supply",
      marketId: "zest.sbtc.vault",
      amount: "50000000", // 0.5 zsBTC in base units (8 decimals)
    }),
  });
  const { data } = await response.json();
  const { quote, plan } = data;

  // 2. Local SDK validation
  const validation = os.validate(parsePlan(plan), parseQuote(quote), { sender: ownerAddress });
  if (!validation.ok) {
    throw new Error(`Exit plan rejected: ${validation.reasons.join("; ")}`);
  }

  // 3. Record workflow state
  let flow = os.startWorkflow({ id: "exit-flow-1", idempotencyKey: "withdraw-sbtc-001" });
  flow = os.recordQuote(flow, parseQuote(quote));
  flow = os.recordPlan(flow, parsePlan(plan), parseQuote(quote), { sender: ownerAddress });

  return { quote, plan, workflow: flow };
}
```

---

## 6. Durable Workflow State Machine

The client SDK manages durable workflows through explicit, auditable states:

```
[IDLE]
  │  os.startWorkflow()
  ▼
[STARTED]
  │  os.recordQuote()
  ▼
[QUOTED]
  │  os.recordPlan()
  ▼
[AWAITING_SIGNATURE]  ◄── SDK halts here; os.submit() throws UNSUPPORTED_ACTION
  │
  ├── User approves in wallet ──► [SIGNED] / [SUBMITTED]
  │                                     │
  │                                     ├── Confirmed on-chain ──► [COMPLETED]
  │                                     │
  │                                     └── Chain reorg / fail ──► [RECOVERY_NEEDED]
  │
  └── User rejects in wallet  ──► [REJECTED]
```

### Safety Invariant: Broadcast Prevention
Calling `os.submit()` on the client SDK unconditionally throws `UNSUPPORTED_ACTION`:
```typescript
try {
  os.submit();
} catch (error) {
  // Expected: SDK never broadcasts writes; host wallet must sign and broadcast.
}
```

---

## 7. Webhook Integration & Verification

Capital OS delivers asynchronous notifications for state updates (e.g. quote expiry, transaction confirmation, workflow completion, liquidation risk alerts).

### Managing Endpoints
Create a webhook subscription using the API:
```bash
POST /v1/webhooks/endpoints
Authorization: Bearer key_<id>.<secret>
Content-Type: application/json

{
  "url": "https://partner.example.com/api/webhooks/capital",
  "events": ["workflow.completed", "workflow.failed", "risk.alert"]
}
```
The response returns a signing secret formatted as `whsec_<48-hex>`. **Store this secret securely.**

### Signature Verification (Node.js)

Capital OS signs every webhook payload with HMAC-SHA256:
- Header: `x-capital-signature: t=<timestamp>,v1=<signature>`
- Signed message format: `${timestamp}.${rawBody}`

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => kv.split("=") as [string, string]),
  );
  const timestamp = Number(parts.t);
  const expectedSignature = parts.v1;

  if (Number.isNaN(timestamp) || !expectedSignature) return false;

  // 1. Replay attack mitigation: tolerance check
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }

  // 2. Calculate HMAC-SHA256
  const hmac = createHmac("sha256", webhookSecret);
  hmac.update(`${timestamp}.${rawBody}`);
  const calculatedSignature = hmac.digest("hex");

  // 3. Constant-time comparison
  const calculatedBuffer = Buffer.from(calculatedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  if (calculatedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(calculatedBuffer, expectedBuffer);
}
```

### Event Deduplication & Idempotency
- Every webhook payload contains a unique `id` (e.g. `evt_019283746`).
- Partners must record processed `event_id`s in an idempotent database table to safely ignore duplicate retries.

---

## 8. Failure Modes, Reorgs & Recovery

Distributed crypto execution occasionally encounters chain reorganizations, stale oracles, or network timeouts. Capital OS classifies errors into actionable recovery paths:

| Error Code | Meaning | Recovery Action |
|---|---|---|
| `QUOTE_EXPIRED` | Quote deadline passed before wallet submission | Call `requote` to refresh terms |
| `ORACLE_STALE` | Price feed age exceeded freshness threshold | Wait for fresh oracle tick, then `requote` |
| `BROADCAST_UNKNOWN` | Transaction broadcast status undetermined | Enter `investigation`; do **not** blindly retry (`allowsWriteRetry === false`) |
| `CAPABILITY_DISABLED` | Protocol action temporarily paused or restricted | Display protocol status banner to user |
| `REORG_DETECTED` | Block hash invalidated by canonical fork | Re-check position delta via `completeFromReconciliation` |

### Workflow Resume Hint
```typescript
import { resumeHint } from "@stacks-capital/sdk";

const hint = resumeHint(workflow);
switch (hint) {
  case "requote":
    // Fetch a new quote for the original intent
    break;
  case "investigate":
    // Poll explorer or await indexer confirmation
    break;
  case "retry":
    // Safely re-submit identical transaction
    break;
}
```

---

## 9. Disposable Sandbox Credentials

The partner example application (`apps/partner-example`) provides isolated, revocable test credentials in [`disposable-test-account.ts`](file:///home/modev/Stacks%20Ecosystem/CapitalOS/apps/partner-example/src/disposable-test-account.ts):

- **Zero Funding Invariant**: Sandbox phrases must never receive real funds.
- **Explicit Revocation**: Credentials can be revoked in memory (`revokeDisposableCredentials()`) or through key management CLI (`pnpm keys:revoke`).
- **Sandbox Address**: Defaults to `FALLBACK_SANDBOX_OWNER` (`SP2C2YFP12AJZB4MABJBAJ55XECVS7E4PMMZ89YZR`) when credentials are not configured.

---

## 10. Running the Partner Example

Run the end-to-end partner example locally against mock fixtures:

```bash
# Run the entry and exit flow
pnpm partner:example

# Run unit tests for partner application
pnpm --filter @stacks-capital/partner-example test
```
