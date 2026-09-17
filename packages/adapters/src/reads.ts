export type EmilyLimits = {
  perDepositMinimum: string;
  perWithdrawalCap: string;
  pegCap?: string;
};

export type VaultSnapshot = {
  pausedDeposit: boolean;
  pausedRedeem: boolean;
  totalAssets: string;
  capSupply: string;
  shareRateNumerator: string;
  shareRateDenominator: string;
};

export type OracleSnapshot = {
  price: string;
  scale: string;
  observedAt: string;
  source: string;
  stale: boolean;
  maxAgeMs: number;
};

export type SwapSnapshot = {
  poolId: string;
  routerId: string;
  amountIn: string;
  amountOut: string;
  xAsset: "sbtc" | "usdcx";
  stale: boolean;
  observedAt: string;
  source: string;
  maxAgeMs: number;
};

export type RiskParamSnapshot = {
  ltvBorrowBps: string;
  ltvLiqBps: string;
  bufferBps: string;
  sbtcDecimals: string;
  usdcxDecimals: string;
};

export type PositionSnapshot = {
  collateral: string;
  debt: string;
};

export type AdapterReads = {
  emilyLimits: EmilyLimits;
  source?: string;
  vault?: VaultSnapshot;
  debtVault?: VaultSnapshot;
  oracle?: { sbtc: OracleSnapshot; usdcx: OracleSnapshot };
  swap?: SwapSnapshot;
  position?: PositionSnapshot;
  riskParams?: RiskParamSnapshot;
  balances?: {
    sbtc?: string;
    zsbtc?: string;
    usdcx?: string;
  };
};
