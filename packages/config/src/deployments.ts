import type { Action } from "@stacks-capital/core";
import type { StacksNetwork } from "@stacks-capital/core";

export const REGISTRY_VERSION = "0.1.0";

/** Onchain SIP-010 names. Post conditions that use a ticker fail on chain. */
export const FUNGIBLE_ASSET_NAME = {
  sbtc: "sbtc-token",
  usdcx: "usdcx-token",
  zestShares: "zft",
} as const;

export type ProviderEndpoints = {
  stacksApi: string;
  emily: string;
  hermes: string;
  bitflowTicker: string | null;
};

export const PROVIDERS: Readonly<Record<StacksNetwork, ProviderEndpoints>> = {
  testnet: {
    stacksApi: "https://api.testnet.hiro.so",
    emily: "https://beta.sbtc-emily.com",
    hermes: "https://hermes-beta.pyth.network",
    bitflowTicker: null,
  },
  mainnet: {
    stacksApi: "https://api.hiro.so",
    emily: "https://sbtc-emily.com",
    hermes: "https://hermes.pyth.network",
    bitflowTicker: "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev/ticker",
  },
};

export type ContractRef = {
  protocol: string;
  label: string;
  network: StacksNetwork;
  contractId: string;
  revision: string;
  role: string;
};

export const CONTRACTS: readonly ContractRef[] = [
  {
    protocol: "sbtc",
    label: "sbtc-token",
    network: "mainnet",
    contractId: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    revision: "328228",
    role: "sip10",
  },
  {
    protocol: "sbtc",
    label: "sbtc-deposit",
    network: "mainnet",
    contractId: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-deposit",
    revision: "328228",
    role: "signer_mint",
  },
  {
    protocol: "sbtc",
    label: "sbtc-withdrawal",
    network: "mainnet",
    contractId: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-withdrawal",
    revision: "328228",
    role: "user_withdraw",
  },
  {
    protocol: "sbtc",
    label: "sbtc-registry",
    network: "mainnet",
    contractId: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry",
    revision: "328228",
    role: "registry",
  },
  {
    protocol: "sbtc",
    label: "sbtc-token",
    network: "testnet",
    contractId: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token",
    revision: "1162",
    role: "sip10",
  },
  {
    protocol: "sbtc",
    label: "sbtc-deposit",
    network: "testnet",
    contractId: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-deposit",
    revision: "1162",
    role: "signer_mint",
  },
  {
    protocol: "sbtc",
    label: "sbtc-withdrawal",
    network: "testnet",
    contractId: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-withdrawal",
    revision: "1163",
    role: "user_withdraw",
  },
  {
    protocol: "sbtc",
    label: "sbtc-registry",
    network: "testnet",
    contractId: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-registry",
    revision: "1162",
    role: "registry",
  },
  {
    protocol: "usdcx",
    label: "usdcx",
    network: "mainnet",
    contractId: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    revision: "5199972",
    role: "sip10",
  },
  {
    protocol: "usdcx",
    label: "usdcx",
    network: "testnet",
    contractId: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx",
    revision: "17815",
    role: "sip10",
  },
  {
    protocol: "granite",
    label: "v0-8-market",
    network: "mainnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market",
    revision: "8883545",
    role: "market",
  },
  {
    protocol: "dia",
    label: "dia-oracle",
    network: "mainnet",
    contractId: "SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle",
    revision: "live",
    role: "oracle",
  },
  {
    protocol: "zest",
    label: "v0-vault-sbtc",
    network: "mainnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
    revision: "6162063",
    role: "earn_vault",
  },
  {
    protocol: "zest",
    label: "v0-4-market",
    network: "mainnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market",
    revision: "6819891",
    role: "superseded_market",
  },
  {
    protocol: "zest",
    label: "v0-vault-usdc",
    network: "mainnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-usdc",
    revision: "6162068",
    role: "debt_vault",
  },
  {
    protocol: "bitflow",
    label: "dlmm-swap-router-v-1-2",
    network: "mainnet",
    contractId: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2",
    revision: "6979616",
    role: "swap_router",
  },
  {
    protocol: "bitflow",
    label: "dlmm-swap-router-v-1-1",
    network: "mainnet",
    contractId: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-1",
    revision: "6909217",
    role: "superseded_router",
  },
  {
    protocol: "pox",
    label: "pox-5",
    network: "mainnet",
    contractId: "SP000000000000000000002Q6VF78.pox-5",
    revision: "8665568",
    role: "staking",
  },
  {
    protocol: "pox",
    label: "pox-5",
    network: "testnet",
    contractId: "ST000000000000000000002AMW42H.pox-5",
    revision: "2822",
    role: "staking",
  },
];

export type CapabilityState = "enabled" | "read_only" | "paused" | "disabled";

export type CapabilityRecord = {
  action: Action;
  protocol: string;
  network: StacksNetwork;
  contractId: string;
  adapterVersion: string;
  state: CapabilityState;
  reason: string;
  wallet: readonly string[];
};

export const CAPABILITIES: readonly CapabilityRecord[] = [
  {
    action: "deposit_sbtc",
    protocol: "sbtc",
    network: "mainnet",
    contractId: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-deposit",
    adapterVersion: "sbtc-deposit@0.1.0",
    state: "enabled",
    reason: "Emily mainnet tracks Hiro; user signs Bitcoin, signers mint",
    wallet: ["leather", "xverse"],
  },
  {
    action: "deposit_sbtc",
    protocol: "sbtc",
    network: "testnet",
    contractId: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-deposit",
    adapterVersion: "sbtc-deposit@0.1.0",
    state: "disabled",
    reason: "I01 F2: Emily beta does not track public Stacks testnet. I02 F1: Leather has no Bitcoin regtest.",
    wallet: ["xverse"],
  },
  {
    action: "withdraw_sbtc",
    protocol: "sbtc",
    network: "mainnet",
    contractId: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-withdrawal",
    adapterVersion: "sbtc-withdraw@0.1.0",
    state: "enabled",
    reason: "User calls initiate-withdrawal-request; completion is signer + Bitcoin payout",
    wallet: ["leather", "xverse"],
  },
  {
    action: "withdraw_sbtc",
    protocol: "sbtc",
    network: "testnet",
    contractId: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-withdrawal",
    adapterVersion: "sbtc-withdraw@0.1.0",
    state: "disabled",
    reason: "Same testnet signer/Emily mismatch as deposit (I01 F2)",
    wallet: ["leather", "xverse"],
  },
  {
    action: "supply",
    protocol: "zest",
    network: "mainnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
    adapterVersion: "zest-earn@0.1.0",
    state: "enabled",
    reason: "v0-vault-sbtc deposit/redeem measured live; pauses off; underlying is sbtc-token",
    wallet: ["leather", "xverse"],
  },
  {
    action: "withdraw_supply",
    protocol: "zest",
    network: "mainnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
    adapterVersion: "zest-earn@0.1.0",
    state: "enabled",
    reason: "redeem(amount, min-out, recipient) with deny-mode post conditions",
    wallet: ["leather", "xverse"],
  },
  {
    action: "supply",
    protocol: "zest",
    network: "testnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc",
    adapterVersion: "zest-earn@0.1.0",
    state: "disabled",
    reason: "Zest v2 contracts are not deployed on public Stacks testnet",
    wallet: ["leather", "xverse"],
  },
  {
    action: "supply",
    protocol: "granite",
    network: "mainnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market",
    adapterVersion: "granite-credit@0.1.0",
    state: "enabled",
    reason: "Isolated sBTC collateral-add on live v0-8-market. Not a Zest zsBTC receipt.",
    wallet: ["leather", "xverse"],
  },
  {
    action: "withdraw_supply",
    protocol: "granite",
    network: "mainnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market",
    adapterVersion: "granite-credit@0.1.0",
    state: "enabled",
    reason: "collateral-remove of isolated sBTC; fail-closed on stale oracle when debt remains",
    wallet: ["leather", "xverse"],
  },
  {
    action: "borrow",
    protocol: "granite",
    network: "mainnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market",
    adapterVersion: "granite-credit@0.1.0",
    state: "enabled",
    reason: "borrow USDCx against isolated sBTC. price-feeds none only if the oracle is already fresh.",
    wallet: ["leather", "xverse"],
  },
  {
    action: "repay",
    protocol: "granite",
    network: "mainnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market",
    adapterVersion: "granite-credit@0.1.0",
    state: "enabled",
    reason: "repay USDCx on v0-8-market; on-behalf-of is optional",
    wallet: ["leather", "xverse"],
  },
  {
    action: "supply",
    protocol: "granite",
    network: "testnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market",
    adapterVersion: "granite-credit@0.1.0",
    state: "disabled",
    reason: "Granite v0-8-market is not deployed on public Stacks testnet",
    wallet: ["leather", "xverse"],
  },
  {
    action: "borrow",
    protocol: "granite",
    network: "testnet",
    contractId: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market",
    adapterVersion: "granite-credit@0.1.0",
    state: "disabled",
    reason: "Granite v0-8-market is not deployed on public Stacks testnet",
    wallet: ["leather", "xverse"],
  },
  {
    action: "swap",
    protocol: "bitflow",
    network: "mainnet",
    contractId: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2",
    adapterVersion: "bitflow-swap@0.1.0",
    state: "enabled",
    reason:
      "Allowlisted sBTC↔USDCx on dlmm-swap-router-v-1-2. Live pool principal is not pinned; fixture routes only until verified.",
    wallet: ["leather", "xverse"],
  },
  {
    action: "swap",
    protocol: "bitflow",
    network: "testnet",
    contractId: "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2",
    adapterVersion: "bitflow-swap@0.1.0",
    state: "disabled",
    reason: "Bitflow has no public testnet ticker or router",
    wallet: ["leather", "xverse"],
  },
  {
    action: "stake",
    protocol: "pox",
    network: "mainnet",
    contractId: "SP000000000000000000002Q6VF78.pox-5",
    adapterVersion: "pox-5@0.1.0",
    state: "disabled",
    reason:
      "K02: pox-5 exists (stake/unstake/unstake-sbtc) but BTC lockup signing path is unverified. Default disabled.",
    wallet: [],
  },
  {
    action: "stake",
    protocol: "pox",
    network: "testnet",
    contractId: "ST000000000000000000002AMW42H.pox-5",
    adapterVersion: "pox-5@0.1.0",
    state: "disabled",
    reason: "K02: staking remains disabled until wallet lockup and production capability are verified",
    wallet: [],
  },
];

export const BITFLOW_ALLOWED_POOLS: readonly string[] = [];

export function contract(protocol: string, label: string, network: StacksNetwork): ContractRef {
  const found = CONTRACTS.find(
    (item) => item.protocol === protocol && item.label === label && item.network === network,
  );
  if (found === undefined) throw new Error(`No contract ${protocol}/${label} on ${network}`);
  return found;
}

export function capabilityFor(action: Action, network: StacksNetwork, protocol?: string): CapabilityRecord | undefined {
  return CAPABILITIES.find(
    (item) =>
      item.action === action && item.network === network && (protocol === undefined || item.protocol === protocol),
  );
}

export function assertExecutable(action: Action, network: StacksNetwork, protocol?: string): CapabilityRecord {
  const found = capabilityFor(action, network, protocol);
  if (found === undefined || found.state !== "enabled") {
    const reason = found?.reason ?? "no capability record";
    throw Object.assign(new Error(`${action} is not executable on ${network}: ${reason}`), {
      code: "CAPABILITY_DISABLED",
    });
  }
  return found;
}
