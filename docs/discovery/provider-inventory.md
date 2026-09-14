# Provider inventory

| | |
|---|---|
| Task | I01 Data access and provider inventory |
| Requirements | CAP-01, POS-01, OPS-01 |
| Owner / reviewer | IBK / kenzman |
| Observed | 2026-09-14, Stacks testnet and mainnet |
| Decision it informs | "Providers, quotas and history" (page 09, due M0) |

For each target this records endpoints, authentication, quotas, freshness, pagination, fallback behavior and missing history. Every value marked "measured" comes from `scripts/probes`. Everything else cites a source at the bottom.

## Scope

Targets come from the spec, not from a wider search:

- Page 01, External providers: RPC, indexer, pricing, protocol endpoints and signer status services.
- Project brief, initial integration scope: sBTC deposit and withdrawal, Bitcoin Staking, Zest, Granite, Bitflow routing and USDCx.

Not covered here: contract, ABI and method verification (K01), reproducing sBTC flows (K02) and market selection (page 09 decisions owned by kenzman).

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm exec tsc -p scripts/probes
node --test scripts/probes/lib.test.ts scripts/probes/live.test.ts
PROBE_LIVE=1 node --test scripts/probes/live.test.ts
node --env-file-if-exists=.env.local scripts/probes/probe.ts --network both
```

- `.env.local` is optional and never committed. The probe reads `HIRO_API_KEY` and `PYTH_API_KEY` and never prints them.
- There is no default network. Running the probe without `--network` stops with an error.
- `live.test.ts` is skipped unless `PROBE_LIVE=1`, so the default test run needs no network access.

## Summary

| Target | Role | Testnet | Mainnet | Auth | Status |
|---|---|---|---|---|---|
| Hiro Stacks API | Indexer and node RPC | `api.testnet.hiro.so` | `api.hiro.so` | Optional key | Usable |
| Bitcoin explorer | Bitcoin RPC and explorer | `mempool.bitcoin.regtest.hiro.so` | `mempool.space`, `blockstream.info` | None | Usable, no testnet fallback |
| Emily | sBTC signer status and limits | `beta.sbtc-emily.com` | `sbtc-emily.com` | None for reads | Mainnet usable, testnet mismatch |
| Pyth Hermes | Pricing | `hermes-beta.pyth.network` | `hermes.pyth.network` | Key required | **Blocked** |
| Zest, Granite | Protocol data | Stacks API reads | Stacks API reads | Via Hiro | No HTTP API |
| Bitflow | Swap market data | None | Public gateway | None | Mainnet only, unstable latency |
| USDCx | Stablecoin | Stacks API reads | Stacks API reads | Via Hiro | Usable |
| PoX | Bitcoin Staking data | `pox-5` | `pox-5` | Via Hiro | Usable |

## Hiro Stacks Blockchain API

**Endpoints.** Testnet `https://api.testnet.hiro.so`, mainnet `https://api.hiro.so`. The extended API lives under `/extended`; node RPC routes such as `/v2/info`, `/v2/pox` and contract read calls live under `/v2`.

**Auth.** Optional `x-api-key` header. Hiro states the key is for server side use only, so it must never reach browser code. From 2026-10-30 the legacy headers `x-hiro-api-key` and `x-partner` stop working.

**Quotas (measured on mainnet with the cache bypassed).**

| | Per second | Per minute |
|---|---|---|
| Without key | 20 | 50 |
| With key | 40 | 900 |
| `/v2/info` | 50 | 1000 |

- Limits differ per endpoint.
- Hiro's docs say 500 requests per minute with a key; the measured headers say 900.
- Testnet sends no rate limit headers with or without a key, so its limits are unknown.
- Hiro announced that from 2026-10-30 anonymous access moves to "5 to 83+ requests per second" depending on the operation, monthly caps go away and paid tiers end.

**Freshness.** `/extended` returns the Stacks tip and burn block height. Mainnet responses are cached at the edge for about 3 seconds (`cache-control: max-age=3`), and a cached response carries the rate limit headers of whichever client filled the cache (measured). Testnet `/extended` is served with `no-cache`.

**Pagination.** `limit` and `offset`. A `limit` above 50 returns HTTP 400 `querystring/limit must be <= 50` (measured). `/extended/v2/blocks` also returns `cursor`, `prev_cursor` and `next_cursor`.

**Versions.** At observation time testnet ran API v9.0.2 and mainnet v9.2.0, so behavior can differ between networks.

**Fallback.** A self hosted Stacks node exposes the same `/v2` RPC. QuickNode and GetBlock list Stacks support; neither was evaluated. There is no known second provider for testnet.

**History.** Mainnet from block 1 at 2021-01-14. Testnet from block 1 at 2026-08-05, so nothing older exists on testnet (measured).

**Event streaming.** Hiro Chainhooks delivers filtered chain events by webhook and supports replaying past blocks. The Chainhooks UI in Hiro Platform is retired on 2026-10-30; the service continues. Not probed.

## Bitcoin explorer and RPC

**Testnet.** Stacks testnet is anchored to a Bitcoin regtest chain, not to testnet3, testnet4 or signet. `/v2/info` reports `parent_network_id` 3669344250, the regtest network magic `0xDAB5BFFA` (measured). Hiro runs a mempool instance for that chain at `https://mempool.bitcoin.regtest.hiro.so/api`, and its tip matched the Stacks burn height with a gap of 0 (measured). This URL was found by probing and search, not in official docs. Public test network explorers cannot serve Stacks testnet data.

**Mainnet.** `https://mempool.space/api` and `https://blockstream.info/api` both matched the Stacks burn height with a gap of 0 (measured).

**Auth and quotas.** No auth and no rate limit headers on any of them (measured). mempool.space enforces limits with HTTP 429 and can ban repeat offenders; exact numbers are not published and higher limits come through enterprise sponsorship. Blockstream has no testnet4 API (measured).

**Fallback.** On mainnet the two explorers back each other up. On testnet Hiro's regtest instance is the only option.

**History.** Full chain history on both mainnet explorers.

## sBTC bridge API (Emily)

**Endpoints.** Mainnet `https://sbtc-emily.com`, testnet `https://beta.sbtc-emily.com`. These are the defaults in the `sbtc` npm package 0.3.2.

**Auth.** Public reads need no auth. Update routes (`PUT /deposit`, `PUT /withdrawal`) need an API gateway key and are meant for signers.

**Public routes (from the OpenAPI spec).**

- `GET /health`, `/chainstate`, `/chainstate/{height}`, `/limits`, `/limits/{account}`
- `GET /deposit`, `/deposit/{txid}`, `/deposit/{txid}/{index}`, `/deposit/recipient/{recipient}`, `/deposit/reclaim-pubkeys/{reclaimPubkeys}`
- `GET /withdrawal`, `/withdrawal/{id}`, `/withdrawal/recipient/{recipient}`, `/withdrawal/sender/{sender}`
- `POST /deposit` to notify Emily of a new deposit

**Quotas.** None documented and no rate limit headers (measured).

**Pagination.** `pageSize` plus an opaque `nextToken` (measured).

**Freshness.** `/chainstate` returns the Stacks and Bitcoin heights Emily has processed. On mainnet it was within one block of Hiro (measured).

**Limits (measured).** Mainnet: `perDepositMinimum` 1000 sats, `perWithdrawalCap` 50100000000 sats. Testnet returns `null` for every limit.

**History.** Retention is not documented. Queries go by status, transaction, recipient or sender, with no time range filter.

**Testnet.** Does not track the public Stacks testnet. See finding 2.

## Pyth Hermes (pricing)

**Endpoints.** Mainnet `https://hermes.pyth.network`, testnet `https://hermes-beta.pyth.network`.

**Auth.** Required since the Pyth Core upgrade on 2026-08-26, sent as `Authorization: Bearer <key>`. Both endpoints returned HTTP 401 without a key (measured). Keys come from Pyth Terminal with a free trial, then paid plans.

**Quotas, pagination, freshness.** Unknown until a key exists.

**Why it matters.** Zest v2 uses Pyth with a maximum price age of 3 minutes, and Granite uses Pyth. On Stacks, `pyth-oracle-v4` exposes `get-price` for the stored price, while `verify-and-update-price-feeds` needs a fresh signed update from Hermes and charges a fee. A borrow or collateral action that needs a fresh price therefore depends on Hermes.

## Zest and Granite

- Neither protocol's docs list a public HTTP data API. Market and position data must come from contract read calls through the Stacks API, so the Hiro quotas above apply.
- Both use Pyth for prices (see above).
- Neither offers a history API. History has to come from indexing chain events through the Stacks API.
- Contracts, ABIs and methods belong to K01 and are not recorded here.

## Bitflow

**Endpoint.** Mainnet public gateway `https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev/ticker`. No testnet endpoint.

**Auth.** None for the public ticker. Bitflow gives out API keys on request for additional SDK data.

**Quotas.** Not documented on the public API page and no rate limit headers (measured).

**Latency (measured).** Very uneven: 16.5 seconds, then a timeout at 30 seconds, then about 0.5 seconds on repeated calls. This looks like cold starts.

**Freshness and history.** The ticker covers the last 24 hours only, with no older data.

**Routing.** The ticker is market data, not routes. Route quotes and swap post conditions come from `@bitflowlabs/core-sdk`, which was not probed.

## USDCx

- Testnet `ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx`, deployed at block 17815 (measured).
- Mainnet `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx`, deployed at block 5199972 (measured).
- Read through the Stacks API. Mainnet read only functions include `get-balance`, `get-balance-available`, `get-balance-locked`, `get-decimals` and `is-protocol-paused`.

## Bitcoin Staking (PoX)

`/v2/pox` works on both networks and reports `ST000000000000000000002AMW42H.pox-5` on testnet and `SP000000000000000000002Q6VF78.pox-5` on mainnet (measured). Staking capability itself belongs to K02 and K16.

## Findings and blockers

1. **Blocked: Pyth Hermes needs an API key.** Pricing for Zest and Granite depends on it. Next action: kenzman decides on budget, which page 04 lists under unscheduled dependencies. Until then pricing is fixture or sandbox only, the page 09 default.
2. **For K02: sBTC testnet services do not track the public Stacks testnet.**
   - `beta.sbtc-emily.com` reports Stacks height near 786,000 and Bitcoin near 22,000. Its current block hash is not found on `api.testnet.hiro.so`, which is near 371,000 with a burn height near 16,500.
   - `beta.sbtc-mempool.tech` serves a regtest chain near height 203,000, far from the Stacks testnet burn height.
   - The `sbtc` npm testnet client uses contract address `SNGWPN3XDAQE673MXYXF81016M50NHF5X5PWWM70`, which has no transactions on Hiro testnet. docs.stacks.co lists `SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token`, which does exist there.
   - Owner: kenzman, to confirm the correct sBTC test environment.
3. **Hiro changes on 2026-10-30.** Only `x-api-key` will authenticate, limits change, and the Chainhooks UI and hosted Devnet are retired.
4. **Testnet has a single provider.** Only Hiro serves Stacks testnet and its Bitcoin regtest chain.
5. **Cached rate limit headers.** Mainnet Hiro responses are cached for about 3 seconds and can return another client's limit headers. Rate limit tracking must ignore headers on a cache hit.
6. **Bitflow latency is unstable.** Callers need timeouts and must mark data stale, following the page 01 degradation rules.

## Unsupported cases

- Bitflow on testnet: no endpoint.
- sBTC flows on testnet through the beta services: unverified, see finding 2.
- Pyth with a key: not measured.
- Hiro testnet limits: unknown, no headers.
- Bitflow routing SDK: not probed.

## Recommendation

| Need | Primary | Fallback |
|---|---|---|
| Stacks data, both networks | Hiro Stacks API with a server side key | Self hosted Stacks node or a third party, to evaluate before production (mainnet only) |
| Bitcoin mainnet | mempool.space | Blockstream Esplora |
| Bitcoin testnet | Hiro regtest mempool | None |
| sBTC status and limits | Emily mainnet | Testnet pending K02 |
| Prices | Blocked on Pyth key | Fixtures until resolved |
| Zest, Granite, USDCx, PoX | Contract reads through Hiro | Same as Stacks data |
| Protocol history | Own ingestion from Stacks events | None |
| Bitflow | Mainnet ticker with timeouts | Routing access needs contact with Bitflow |

## Sources

- [Hiro: Introducing free API access for every Stacks builder](https://www.hiro.so/blog/introducing-free-api-access-for-every-stacks-builder)
- [Hiro Docs: API keys](https://docs.hiro.so/en/resources/guides/api-keys)
- [Hiro Docs: Chainhooks](https://docs.hiro.so/en/tools/chainhooks)
- [Hiro: The challenges of building on Bitcoin testnet](https://www.hiro.so/blog/the-challenges-of-building-on-bitcoin-testnet)
- [Stacks Docs: Mainnet and testnets](https://docs.stacks.co/learn/network-fundamentals/mainnet-and-testnets)
- [Stacks Docs: Depositing BTC into sBTC](https://docs.stacks.co/more-guides/sbtc/bridging-bitcoin/btc-to-sbtc.md)
- [Emily public OpenAPI spec](https://github.com/stacks-sbtc/sbtc/blob/main/emily/openapi-gen/generated-specs/public-emily-openapi-spec.json)
- [sbtc npm package](https://www.npmjs.com/package/sbtc)
- [Pyth: Preparing for the Pyth Core upgrade](https://docs.pyth.network/price-feeds/core/upgrade/preparing)
- [Stacks Docs: Using Pyth with Stacks](https://docs.stacks.co/more-guides/price-oracles/pyth)
- [Zest Docs: Oracles](https://docs.zestprotocol.com/start/borrow/v2-market-design/oracles.md)
- [Granite Docs: Oracle implementation](https://docs.granite.world/protocol-mechanics/oracle-implementation.md)
- [Bitflow Docs: Public API](https://docs.bitflow.finance/bitflow-documentation/developers/public-api-documentation)
- [Stacks Docs: Bridging USDCx](https://docs.stacks.co/more-guides/bridging-usdcx)
- [mempool: API rate limit documentation issue](https://github.com/mempool/mempool/issues/4106)
- [compareNodes: Stacks RPC providers](https://www.comparenodes.com/protocols/stacks/)
