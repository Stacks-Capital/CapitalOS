import type { AssetAmount } from "./amounts.ts";
import type { MarketId, QuoteId } from "./ids.ts";
import type { StacksNetwork } from "./network.ts";

export type Action =
  | "deposit_sbtc"
  | "withdraw_sbtc"
  | "supply"
  | "withdraw_supply"
  | "borrow"
  | "repay"
  | "swap"
  | "stake";

export type FeeKind = "miner" | "signer" | "protocol" | "network";

export type Fee = {
  kind: FeeKind;
  amount: AssetAmount;
  max?: AssetAmount;
};

export type Quote = {
  id: QuoteId;
  action: Action;
  marketId: MarketId;
  network: StacksNetwork;
  input: AssetAmount[];
  expectedOutput: AssetAmount[];
  fees: Fee[];
  snapshots: string[];
  expiresAt: string;
  executable: boolean;
  warnings: string[];
  registryVersion: string;
  adapterVersion: string;
  minimumOutput?: AssetAmount;
};

export function quoteExpired(quote: Quote, now: Date): boolean {
  return now.toISOString() >= quote.expiresAt;
}
