# Wallet feasibility

| | |
|---|---|
| Task | I02 Wallet and product feasibility prototype |
| Requirements | SBTC-01, EARN-01, WF-01 |
| Owner / reviewer | IBK / kenzman |
| Observed | 2026-09-15, Stacks testnet |
| Wallets | Leather 6.112.0, Xverse 2.9.1 |
| Browsers | Google Chrome 153.0.8010.36, Brave 1.95.101 |
| Libraries | `@stacks/connect` 8.2.7, `@stacks/transactions` 7.6.0, `@scure/btc-signer` 2.4.1 |

This records what Leather and Xverse can and cannot do for the product journeys, how network selection and switching behave, and which product failure state each wallet response maps to. Results come from running `prototypes/wallet-feasibility` with test accounts in both browsers. The raw logs stay on the tester's machine, so this doc quotes them by file name and UTC time. Every transaction listed under Evidence can be checked on chain.

## Scope

From the I02 deliverable: test Leather and Xverse connection and network switching, map required signing capabilities and product failure states. Measured against:

- Page 04, M0 exit evidence: wallet, account and network support tested; unsupported actions disabled rather than mocked.
- Page 05, Journey 0 (connect, separate Bitcoin and Stacks accounts, network confirmation, nonce signature) and Journeys 1, 2 and 7 (PSBT, contract call with post conditions, withdrawal call).
- Page 06, stage 8 wallet results and the error contract. Page 03, transaction integrity controls.

Not covered here: product wallet screens (I09), the final `packages/wallets` interfaces, protocol transaction building (K tasks) and mainnet.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm --filter @stacks-capital/wallet-feasibility test
pnpm --filter @stacks-capital/wallet-feasibility typecheck
pnpm --filter @stacks-capital/wallet-feasibility dev
```

Open `http://localhost:5173` with Leather or Xverse set to test mode and a funded Stacks testnet account. Never use a production seed phrase. Tests 4, 5 and 4b cost testnet fees. Test 7 signs a PSBT that spends a made-up input with broadcast turned off, so it can never reach a chain.

| Button | What it does |
|---|---|
| 0 | Lists the provider's methods and whether `@stacks/connect` treats it as Xverse |
| 1 | Connect through `@stacks/connect` with `network: "testnet"` |
| 1c, 1d | Raw `wallet_connect` and raw `getAddresses` with purposes |
| 1e | Connect through `@stacks/connect` without a network |
| 1f | Raw `wallet_connect` with `network: "testnet"` |
| 2, 2b | `wallet_getNetwork`, `supportedMethods` |
| 3 | `stx_signMessage` with a random nonce |
| 4 | Sends 1 micro STX to `ST000000000000000000002AMW42H` |
| 4b | Sends to self, which the node refuses |
| 5 | sBTC `transfer` of 1 with a deny mode post condition; aborts because the account holds no sBTC |
| 6 | Looks up the last transaction on the Hiro testnet API |
| 7 | `signPsbt` without broadcast |

Every request is logged as pending the moment it starts and notes when a wallet has not answered after 60 seconds.

## Capability matrix

| Capability | Leather 6.112.0 | Xverse 2.9.1 | Spec need |
|---|---|---|---|
| Connect | `getAddresses` returns BTC `p2wpkh` (`tb1q`), BTC `p2tr` (`tb1p`) and STX (`ST`) as separate entries, plus derivation path and descriptor | Works only without a lowercase network (see Network behavior). Returns payment, ordinals, stacks, starknet and spark addresses, each with a `purpose`, plus the active network | Journey 0: separate Bitcoin and Stacks accounts |
| Read the network | `wallet_getNetwork` returns `-32601` not supported | Included in the connect response, and `wallet_getNetwork` works | Journey 0: confirm testnet or mainnet |
| Detect a network switch | Not possible | Visible by polling `wallet_getNetwork`, no reconnect needed | Journey 0: invalidate quotes and plans on change |
| Bitcoin network matching Stacks testnet (regtest) | Not available | Available with Bitcoin set to Regtest | I01: Stacks testnet is anchored to regtest |
| Sign a message | 65 byte signature (130 hex chars) plus the STX public key | Same | Journey 0 nonce, page 03 wallet auth |
| STX transfer | Broadcasts and returns `txid` and `transaction`. Fee 300 micro STX | Same. Fee 14,950 micro STX | Page 02 fee reserve |
| Contract call with post conditions | Deny mode and the post condition reach the chain unchanged. Fee 701 | Same. Fee 3,000 | Page 03 post conditions |
| Sign a PSBT without broadcast | Signs. Response has `hex` from Leather and `psbt` (base64) added by `@stacks/connect`. Public test networks only | Signs on Signet and Regtest. Response has `psbt` (base64) and `txid: ""` | Journey 1 BTC deposit |
| `supportedMethods` | Answers, but lists only Bitcoin methods although `stx_` methods work | Never answers | Capability detection |

## Network behavior

**Leather.** The network menu offers Mainnet, Testnet4, Testnet3 and Signet, and every test option uses `api.testnet.hiro.so` for Stacks. There is no regtest option. Switching from Testnet4 to Signet returned identical `tb1` addresses (`chrome-leather-1.json`, 09:54 and 10:00), `wallet_getNetwork` is not supported and no change events exist, so the app cannot tell which Bitcoin network Leather is on.

**Xverse.** Testnet mode pairs Stacks Testnet with Bitcoin Signet or Regtest. The same keys produce `tb1q4ehwp…` on Signet and `bcrt1q4ehwp…` on Regtest, and the connect response names the network. `wallet_getNetwork` reported Signet at 12:43:06 and Regtest at 12:43:47 after a switch with no reconnect (`chrome-xverse-network.json`).

**Matching Stacks testnet.** Stacks testnet is anchored to Bitcoin regtest (I01), so only Xverse on Regtest returns Bitcoin addresses of the right kind. Whether Xverse's Regtest is the same regtest chain that Stacks testnet uses is not verified; that needs a funded address.

**Lowercase network hangs Xverse.** Xverse's `wallet_connect` accepts `network` only as `"Mainnet"`, `"Testnet"` or `"Signet"` (`@sats-connect/core` 0.18.0 schema). `@stacks/connect` rewrites `getAddresses` into `wallet_connect` for Xverse and forwards `"testnet"` unchanged, so Xverse never answers. Test 1 stayed pending in the 11:00 and 11:04 runs, raw test 1f stayed pending in Chrome at 11:30 and Brave at 11:38, and test 1e without a network connected immediately.

## Failure states

| Situation | Leather | Xverse | Product state (page 06) |
|---|---|---|---|
| User rejects the prompt | `4001` "User denied signing" or "User rejected request" | `-32000` "User rejected the message signing request" | `USER_REJECTED` |
| Node refuses the broadcast after approval | Wallet shows "Unable to broadcast". App gets `4001` "User rejected request" | Wallet shows `StacksTransactionBroadcastRejectedError: TransferRecipientCannotEqualSender`. App gets `-32000` "User rejected the Stacks transaction signing request" | Indistinguishable from `USER_REJECTED`. Check the account nonce and mempool before telling the user they rejected |
| Approved, nothing broadcast, no answer | Not observed | Observed once: contract call approved at 11:35:26 in Chrome never answered, and the account nonces show no transaction between 11:34 and 11:40. Not reproduced at 12:17 | Pending with a timeout, then `BROADCAST_UNKNOWN`. Look up nonce and mempool, never retry automatically |
| Unknown method | `-32601` with a message | No answer (`supportedMethods`, 12:43:19) | `UNSUPPORTED_WALLET` after a timeout |
| Invalid parameters | Not observed | No answer (lowercase network) | Timeout, then treat as a developer error |
| Malformed PSBT | `@stacks/connect` throws a base64 decode error before any prompt | `-32603` "The requested transaction is invalid and cannot be processed" | Developer error, `UNCLASSIFIED` |
| Wallet not installed | Provider missing | Provider missing | `UNSUPPORTED_WALLET` |
| Wrong Bitcoin network for Stacks testnet | Always (`tb1` addresses) | When Bitcoin is on Signet | `NETWORK_MISMATCH`, block signing |
| Transaction aborts on chain | Contract call `(err u2)` seen on Hiro | Same | Failed with the protocol reason |

The code `-32001` means "address mismatch" in `@stacks/connect` but "method not supported" in `@sats-connect/core`, so `src/guards.ts` classifies errors per wallet.

## Findings for the team

1. **Leather cannot do BTC to sBTC on Stacks testnet.** It has no regtest option. Xverse on Regtest is the only candidate, and its regtest chain still has to be matched to Stacks testnet with a funded address. Owner: kenzman (K02, SBTC-01).
2. **Never pass a lowercase network to `@stacks/connect` for Xverse.** Connect without a network and read it from the response, or map it to `"Testnet"`. Affects I07 and I08.
3. **Re-read the wallet network before every signing request.** Xverse through `wallet_getNetwork`. Leather offers no way, so a Leather session cannot detect a Bitcoin network switch at all.
4. **A "user rejected" error can be a node refusal.** Both wallets report it that way. The product must check nonce and mempool before showing a rejection.
5. **Every wallet request needs a timeout.** Xverse stays silent on invalid parameters, unknown methods and once after an approval.
6. **Do not detect capabilities with `supportedMethods`.** Leather's list is incomplete and Xverse does not answer. Use the tested wallet identity and version with the capability registry.
7. **Default fees differ by about 50 times** for the same STX transfer (300 against 14,950 micro STX). Fee display and reserve must use the fee the wallet will set, or set it explicitly. Product decision.
8. **Post conditions work in both wallets.** The Stacks Connect wallet support table says Xverse drops them; that is outdated for 2.9.1.
9. **Treat an empty `txid` as not broadcast.** Xverse returns `txid: ""` when broadcast is off.
10. **Bundle size.** `@stacks/connect` pulls in the WalletConnect UI, and the prototype build has a 550 kB chunk. Note for I09.

## Integration pitfalls found while building the prototype

- Xverse exposes `request()` on `window.XverseProviders.BitcoinProvider` for both Bitcoin and Stacks methods. `XverseProviders.StacksProvider` has no `request()` and fails with "`request` function is not implemented".
- `@stacks/connect` expects PSBTs in base64. It base64 decodes them for Leather and passes them unchanged to Xverse.
- Stacks nodes refuse STX transfers where recipient equals sender (`MemPoolRejection::TransferRecipientIsSender`).
- pnpm install scripts for `@reown/appkit` and `secp256k1` are blocked (`allowBuilds: false`), and the prototype works without them.

## Unsupported and not tested

- Mainnet, by design.
- Broadcasting a Bitcoin transaction, or signing a PSBT that spends a real input.
- `stx_signStructuredMessage`, `stx_signTransaction`, `sendTransfer` and `stx_deployContract`.
- Verifying message signatures (belongs to auth work).
- WalletConnect, mobile wallets, Firefox and other wallets.
- Leather network switches other than Testnet4 to Signet, and Xverse custom networks (`wallet_addNetwork`).
- Which regtest chain Xverse uses.

## Configuration

Prototype constants live in `prototypes/wallet-feasibility/src/main.ts`: network `testnet`, sBTC testnet token `SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token`, transfer recipient `ST000000000000000000002AMW42H` and the Hiro testnet API. No API keys are used. The workspace now includes `prototypes/*`.

## Evidence

Local logs used for this doc: `chrome-leather-1.json`, `chrome-leather-2.json`, `brave-leather.json`, `chrome-leather-psbt-3.json`, `brave-leather-psbt-3.json`, `chrome-xverse-diagnostics.json`, `chrome-xverse.json`, `brave-xverse.json`, `chrome-xverse-psbt-3.json`, `brave-xverse-psbt-3.json` and `chrome-xverse-network.json`.

Transactions on Stacks testnet:

| Wallet | Nonce | Test | Result | Fee | Post conditions | Transaction |
|---|---|---|---|---|---|---|
| Leather | 0 | Contract call | `(err u2)` | 701 | deny, 1 | `0xb9743976ef797e23a29ef1e1be3e924ba7881a833185ba9d5e5eaaa1597ba464` |
| Leather | 1 | STX transfer, Chrome | success | 300 | none | `0x14706c0d1330de77e36bc04e93d955683dcc3665c046cb7e28ce18f3c3e93edf` |
| Leather | 2 | STX transfer, Brave | success | 300 | none | `0xb9f0a72fb528471d2b1bbb75e986f61041a9b9d7145daa6b30fc6451cf3ea354` |
| Leather | 3 | Contract call, Brave | `(err u2)` | 701 | deny, 1 | `0xe5b67f908bbb7f9cedf8013b25f8d9fae774405c064f1a419cd9344d87e84c80` |
| Xverse | 0 | STX transfer, Chrome | success | 14,950 | none | `0x3085fb5052a13b295dc36bed1e1e3e915b14e8541df85d275758cf58fd57e584` |
| Xverse | 1 | STX transfer, Brave | success | 14,950 | none | `0x1f0f85efe9b5dbf0c7fef79ee4e54e3496206097e1bc094830f3750a5f622609` |
| Xverse | 2 | Contract call, Brave | `(err u2)` | 3,000 | deny, 1 | `0x9081b2261c41451a975a1a47939e8b18995f54b04ad4108d093e892145082bb2` |
| Xverse | 3 | Contract call, Chrome | `(err u2)` | 3,000 | deny, 1 | `0x43609151ad99b2b474480bc17bc10553bb195fdaf4747d5fd0f08765f6781e41` |

Test accounts: Leather `ST20YV8P5YG5RZ59QPCBAN4FEVP2F20EABVGZCPK0`, Xverse `ST1D9X179MAJ9XA7KHSZJ48CN39DVB6TAQDYST34R`. Fees are in micro STX.

## Sources

- [Stacks Connect: Wallet support](https://docs.stacks.co/stacks-connect/wallet-support)
- [Stacks Connect: connect()](https://docs.stacks.co/reference/stacks.js/stacks-connect/connection/connect.md)
- [Leather: getAddresses](https://leather.gitbook.io/developers/methods/getaddresses)
- [Leather: signPsbt](https://leather.gitbook.io/developers/bitcoin-methods/signpsbt)
- [Xverse: request methods](https://docs.xverse.app/sats-connect/wallet-methods/request-methods)
- [Xverse: wallet_getNetwork](https://docs.xverse.app/sats-connect/wallet-methods/wallet_getnetwork)
- [Xverse: stx_callContract](https://docs.xverse.app/sats-connect/stacks-methods/stx_callcontract)
- [stacks-core: mempool rejection test](https://github.com/stacks-network/stacks-core/blob/master/stacks-node/src/tests/mempool.rs)
- [@sats-connect/core on npm](https://www.npmjs.com/package/@sats-connect/core)
