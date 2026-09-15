import type { Network } from "./lib.ts";

export type BitcoinApi = { name: string; base: string; expectedChain: string };
export type Contract = { target: string; label: string; id: string };

export type NetworkTargets = {
  stacksApi: string;
  bitcoinApis: BitcoinApi[];
  emily: string;
  hermes: string;
  bitflowTicker: string | null;
  contracts: Contract[];
};

export const PYTH_BTC_USD_FEED = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

export const TARGETS: Record<Network, NetworkTargets> = {
  testnet: {
    stacksApi: "https://api.testnet.hiro.so",
    bitcoinApis: [
      { name: "Hiro regtest mempool", base: "https://mempool.bitcoin.regtest.hiro.so/api", expectedChain: "regtest" },
      { name: "sBTC beta mempool proxy", base: "https://beta.sbtc-mempool.tech/api/proxy", expectedChain: "regtest" },
    ],
    emily: "https://beta.sbtc-emily.com",
    hermes: "https://hermes-beta.pyth.network",
    bitflowTicker: null,
    contracts: [
      { target: "sBTC", label: "sbtc-token from docs.stacks.co", id: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token" },
      { target: "sBTC", label: "sbtc-token from sbtc npm testnet client", id: "SNGWPN3XDAQE673MXYXF81016M50NHF5X5PWWM70.sbtc-token" },
      { target: "USDCx", label: "usdcx", id: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx" },
    ],
  },
  mainnet: {
    stacksApi: "https://api.hiro.so",
    bitcoinApis: [
      { name: "mempool.space", base: "https://mempool.space/api", expectedChain: "mainnet" },
      { name: "Blockstream Esplora", base: "https://blockstream.info/api", expectedChain: "mainnet" },
    ],
    emily: "https://sbtc-emily.com",
    hermes: "https://hermes.pyth.network",
    bitflowTicker: "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev/ticker",
    contracts: [
      { target: "sBTC", label: "sbtc-token", id: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token" },
      { target: "USDCx", label: "usdcx", id: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx" },
    ],
  },
};
